// src/controllers/documentController.js
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import DriverDoc from "../models/DriverDoc.js";
import requiredDocs from "../utils/requiredDocs.js";
import User from "../models/User.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("📄 documentController loaded");

/**
 * ✅ Helper: recompute user's overall documentStatus + isVerified
 * based on all DriverDoc records for their vehicleType.
 */
const recomputeDriverDocumentStatus = async (userId) => {
  try {
    const driver = await User.findById(userId).lean();
    if (!driver) {
      console.warn("⚠️ recomputeDriverDocumentStatus: user not found", userId);
      return;
    }

    const vehicleType = (driver.vehicleType || "").toString().trim().toLowerCase();
    if (!vehicleType) {
      console.warn(
        "⚠️ recomputeDriverDocumentStatus: user has no vehicleType",
        userId
      );
      return;
    }

    // requiredDocs is config from ../utils/requiredDocs.js
    const requiredForVehicle = (requiredDocs[vehicleType] || []).map((d) =>
      d.toString().toLowerCase()
    );

    if (!requiredForVehicle.length) {
      console.log(
        `ℹ️ No requiredDocs config for vehicleType='${vehicleType}', skipping recompute for user ${userId}`
      );
      return;
    }

    // Fetch all docs for this user & vehicleType that are not deleted
    const docs = await DriverDoc.find({
      userId: userId.toString(),
      vehicleType: vehicleType,
      imageDeleted: { $ne: true },
    }).lean();

    if (!docs.length) {
      // No docs uploaded → definitely pending
      await User.findByIdAndUpdate(userId, {
        documentStatus: "pending",
        isVerified: false,
      });
      return;
    }

    // Group docs by docType
    const docsByType = new Map(); // docType -> [docs]
    for (const d of docs) {
      const type = (d.docType || "").toString().toLowerCase();
      if (!type) continue;
      if (!docsByType.has(type)) docsByType.set(type, []);
      docsByType.get(type).push(d);
    }

    let allRequiredUploaded = true;
    let allApproved = true;
    let anyRejected = false;
    let anyPending = false;

    // Evaluate status per required doc type
    for (const docType of requiredForVehicle) {
      const list = docsByType.get(docType) || [];

      if (!list.length) {
        // missing required doc
        allRequiredUploaded = false;
        allApproved = false;
        anyPending = true; // treat as pending
        continue;
      }

      let typeStatus = "approved"; // optimistic

      for (const d of list) {
        const s = (d.status || "pending").toString().toLowerCase();

        if (s === "rejected") {
          typeStatus = "rejected";
          anyRejected = true;
          allApproved = false;
          break;
        } else if (s === "pending") {
          if (typeStatus !== "rejected") typeStatus = "pending";
          anyPending = true;
          allApproved = false;
        } else if (s === "verified" || s === "approved") {
          // ok, keep optimistic
        } else {
          // unknown → treat as pending
          typeStatus = "pending";
          anyPending = true;
          allApproved = false;
        }
      }
    }

    let newDocumentStatus = "pending";
    let isVerified = false;

    if (allRequiredUploaded && allApproved) {
      newDocumentStatus = "approved";
      isVerified = true;
    } else if (anyRejected) {
      newDocumentStatus = "rejected";
      isVerified = false;
    } else {
      newDocumentStatus = "pending";
      isVerified = false;
    }

    await User.findByIdAndUpdate(userId, {
      documentStatus: newDocumentStatus,
      isVerified,
    });

    console.log(
      `✅ recomputeDriverDocumentStatus → user=${userId} vehicleType=${vehicleType} status=${newDocumentStatus} isVerified=${isVerified}`
    );
  } catch (err) {
    console.error("❌ recomputeDriverDocumentStatus error:", err);
  }
};

/**
 * @desc    Get authenticated driver's profile
 * @route   GET /api/driver/profile
 * @access  Private (Driver)
 */
export const getDriverProfile = async (req, res) => {
  try {
    // Support middleware that sets either id or uid
    const userId = (req.user && (req.user.id || req.user.uid)) || null;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const driver = await User.findById(userId).lean();

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    res.status(200).json({
      driver: {
        _id: driver._id,
        name: driver.name,
        phone: driver.phone,
        email: driver.email || null,
        photoUrl: driver.profilePhotoUrl || null,
        vehicleType: driver.vehicleType,
        rating: driver.rating || 5.0,
        totalTrips: driver.totalTrips || 0,
        acceptsLongTrips: driver.acceptsLongTrips || false,
        documentStatus: driver.documentStatus,
        role: driver.role,
        isDriver: driver.isDriver,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching driver profile:", err);
    res.status(500).json({
      message: "Error fetching driver profile",
      error: err.message,
    });
  }
};

/**
 * Upload driver document (DL, Aadhaar, PAN, etc.)
 * POST /api/driver/uploadDocument
 *
 * NOTE: multer should be configured to accept the file under field name 'document'
 * Example route:
 *   router.post(
 *     '/api/driver/uploadDocument',
 *     firebaseAuth,
 *     upload.single('document'),
 *     uploadDriverDocument
 *   );
 */
export const uploadDriverDocument = async (req, res) => {
  try {
    // Extract userId (support common shapes from auth middleware)
    const userId =
      (req.user && (req.user.id || req.user.uid || req.user.sub)) || null;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // multer should populate req.file
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }
    const file = req.file;

    // Read incoming fields (may be undefined)
    let { docType, vehicleType, extractedData, docSide } = req.body || {};

    // Parse extractedData safely (it may be a JSON string or already-parsed object)
    let parsedExtracted = {};
    try {
      if (typeof extractedData === "string") {
        parsedExtracted =
          extractedData.trim() === "" ? {} : JSON.parse(extractedData);
      } else if (typeof extractedData === "object" && extractedData !== null) {
        parsedExtracted = extractedData;
      } else {
        parsedExtracted = {};
      }
    } catch (e) {
      // If parsing fails, fallback to empty object and continue (we don't want to reject upload)
      console.warn(
        "⚠️ extractedData JSON parse failed, storing empty object:",
        e.message
      );
      parsedExtracted = {};
    }

    // Normalize docType and vehicleType and side for consistent storage/validation
    const docTypeNormalized = (docType || "").toString().trim().toLowerCase();
    const vehicleTypeNormalized = (vehicleType || "")
      .toString()
      .trim()
      .toLowerCase();
    const side = (docSide || "front").toString().trim().toLowerCase();

    // Validate required fields (we require docType and vehicleType; extractedData is optional)
    if (!docTypeNormalized || !vehicleTypeNormalized) {
      return res
        .status(400)
        .json({ message: "docType and vehicleType are required." });
    }

    // Validate docType against allowed docs for vehicleType (case-insensitive)
    // requiredDocs may have keys in any case; map keys to lowercase for safety
    const requiredDocsLowerMap = {};
    Object.keys(requiredDocs).forEach((k) => {
      requiredDocsLowerMap[k.toString().toLowerCase()] = (
        requiredDocs[k] || []
      ).map((d) => d.toString().toLowerCase());
    });

    const allowedDocs = requiredDocsLowerMap[vehicleTypeNormalized] || [];
    if (allowedDocs.length > 0 && !allowedDocs.includes(docTypeNormalized)) {
      return res.status(400).json({
        message: `Invalid docType '${docType}' for vehicleType '${vehicleType}'. Allowed: ${allowedDocs.join(
          ", "
        )}`,
      });
    }

    // Find user to get phone (for renaming file) and ensure user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Build a new filename using phone/docType/side to avoid collisions (keep extension)
    const ext = path.extname(file.originalname) || "";
    const safePhone = (user.phone || "unknown")
      .toString()
      .replace(/[^0-9+]/g, "");
    const safeDocType = docTypeNormalized.replace(/\s+/g, "_");
    const newFileName = `${safePhone}.${safeDocType}.${side}${ext}`;
    const newPath = path.join(path.dirname(file.path), newFileName);

    // Rename file synchronously (acceptable for small single operations)
    try {
      fs.renameSync(file.path, newPath);
    } catch (renameErr) {
      console.error("❌ Failed to rename uploaded file:", renameErr);
      // If rename fails, continue but save original path
    }

    // Create and save DriverDoc with normalized values and parsedExtracted
    const newDoc = new DriverDoc({
      userId: userId.toString(),
      docType: docTypeNormalized,
      side,
      url: newPath,
      status: "pending",
      remarks: "",
      extractedData: parsedExtracted,
      vehicleType: vehicleTypeNormalized,
    });

    await newDoc.save();

    // ✅ Recompute user's overall documentStatus + isVerified
    await recomputeDriverDocumentStatus(userId.toString());

    // Optionally return updated driver info for client
    const updatedDriver = await User.findById(userId)
      .select("_id documentStatus isVerified vehicleType")
      .lean();

    return res.status(200).json({
      message: `${docTypeNormalized} ${side} uploaded successfully`,
      document: newDoc,
      driver: updatedDriver || null,
    });
  } catch (err) {
    console.error("❌ Error uploading driver document:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

/**
 * Get all documents for a driver
 * GET /api/driver/documents/:driverId
 */
export const getDriverDocuments = async (req, res) => {
  const { driverId } = req.params;

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const docs = await DriverDoc.find({ userId: driverId }).lean();

    // Get driver's vehicle type (optional)
    const driver = await User.findById(driverId).lean();
    const vehicleType = driver?.vehicleType || null;

    if (!docs || docs.length === 0) {
      return res.status(200).json({
        message: "No documents found for this driver.",
        docs: [],
        vehicleType,
      });
    }

    // Normalize stored file path to public URL (assumes files are saved under /uploads/...)
    const docsWithImageUrl = docs.map((doc) => {
      let imageUrl = null;
      if (doc.url) {
        // Replace backslashes and try to cut from 'uploads/' if present
        let cleanPath = doc.url.replace(/\\/g, "/");
        const uploadsIndex = cleanPath.indexOf("uploads/");
        if (uploadsIndex !== -1) {
          cleanPath = cleanPath.substring(uploadsIndex);
        } else {
          // If uploads/ not found, try to find last occurrence of 'public' or 'static' folders
          const publicIdx = cleanPath.lastIndexOf("public/");
          if (publicIdx !== -1) {
            cleanPath = cleanPath.substring(publicIdx + "public/".length);
          } else {
            // fallback to file basename
            cleanPath = path.basename(cleanPath);
            cleanPath = `uploads/${cleanPath}`;
          }
        }
        imageUrl = `${baseUrl}/${cleanPath}`;
        console.log(`📸 Document URL: ${imageUrl}`);
      }
      return {
        ...doc,
        imageUrl,
      };
    });

    return res.status(200).json({
      docs: docsWithImageUrl,
      vehicleType,
    });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

// REPLACE resendDriverDocument WITH THIS COMPLETE FUNCTION
export const resendDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;

    const userId =
      (req.user && (req.user.id || req.user.uid || req.user.sub)) || null;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const existing = await DriverDoc.findById(docId);
    if (!existing) {
      return res.status(404).json({ message: "Document not found." });
    }

    if (existing.userId.toString() !== userId.toString()) {
      return res.status(403).json({ message: "Not allowed." });
    }

    // Mark as pending again and clear remarks
    existing.status = "pending";
    existing.remarks = "";
    await existing.save();

    // ✅ Recompute overall driver status (likely from rejected → pending)
    await recomputeDriverDocumentStatus(userId.toString());

    return res.status(200).json({
      message: "Document ready for re-upload",
      docId: existing._id,
      docType: existing.docType,
      side: existing.side,
    });
  } catch (err) {
    console.error("❌ Resend document error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Get driver details by ID
 * @route   GET /api/driver/:driverId
 * @access  Private (Driver)
 */
export const getDriverById = async (req, res) => {
  try {
    const { driverId } = req.params;
    const driver = await User.findById(driverId).lean();

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    return res.status(200).json(driver);
  } catch (err) {
    console.error("❌ Error fetching driver details:", err);
    return res.status(500).json({
      message: "Error fetching driver details",
      error: err.message,
    });
  }
};
