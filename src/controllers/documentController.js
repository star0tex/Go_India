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

// ======================================================================
// 🔧 Helper: Recompute Driver Document Status
// ======================================================================

/**
 * ✅ Helper: recompute user's overall documentStatus + isVerified
 * based on all DriverDoc records for their vehicleType.
 */
export const recomputeDriverDocumentStatus = async (userId) => {
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

    const requiredForVehicle = (requiredDocs[vehicleType] || []).map((d) =>
      d.toString().toLowerCase()
    );

    if (!requiredForVehicle.length) {
      console.log(
        `ℹ️ No requiredDocs config for vehicleType='${vehicleType}', skipping recompute for user ${userId}`
      );
      return;
    }

    const docs = await DriverDoc.find({
      userId: userId.toString(),
      vehicleType: vehicleType,
      imageDeleted: { $ne: true },
    }).lean();

    if (!docs.length) {
      await User.findByIdAndUpdate(userId, {
        documentStatus: "pending",
        isVerified: false,
      });
      return;
    }

    const docsByType = new Map();
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

    for (const docType of requiredForVehicle) {
      const list = docsByType.get(docType) || [];

      if (!list.length) {
        allRequiredUploaded = false;
        allApproved = false;
        anyPending = true;
        continue;
      }

      let typeStatus = "approved";

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
          // ok
        } else {
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

// ======================================================================
// 👤 Driver Profile
// ======================================================================

/**
 * @desc    Get authenticated driver's profile
 * @route   GET /api/driver/profile
 * @access  Private (Driver)
 */
export const getDriverProfile = async (req, res) => {
  try {
    console.log("");
    console.log("=".repeat(70));
    console.log("👤 GET DRIVER PROFILE REQUEST");
    console.log("=".repeat(70));
    console.log(`   User ID from token: ${req.user?.id || req.user?.uid}`);
    console.log("=".repeat(70));

    // req.user is populated by your Firebase auth middleware
    const userId = (req.user && (req.user.id || req.user.uid)) || null;

    if (!userId) {
      console.log("   ❌ User not authenticated");
      console.log("=".repeat(70));
      console.log("");
      return res.status(401).json({ message: "User not authenticated" });
    }

    // ✅ Ensure documentStatus is always fresh
    try {
      await recomputeDriverDocumentStatus(userId.toString());
    } catch (err) {
      console.error("⚠️ Failed to recompute in getDriverProfile:", err.message);
    }

    // Find user by MongoDB _id
    const driver = await User.findById(userId).lean();

    if (!driver) {
      console.log("   ❌ Driver not found");
      console.log("=".repeat(70));
      console.log("");
      return res.status(404).json({ message: "Driver not found" });
    }

    console.log(`   ✅ Profile found: ${driver.name} (${driver.phone})`);
    console.log("=".repeat(70));
    console.log("");

    // Get document count – use driver._id as string (matches DriverDoc.userId: String)
    const documentCount = await DriverDoc.countDocuments({
      userId: driver._id.toString(),
    });

    // Format the response to match what the Flutter app expects
    res.status(200).json({
      driver: {
        _id: driver._id,
        name: driver.name,
        phone: driver.phone,
        email: driver.email || null,
        photoUrl: driver.profilePhotoUrl || null,
        vehicleType: driver.vehicleType,
        vehicleNumber: driver.vehicleNumber || null,
        rating: driver.rating || 5.0,
        totalTrips: driver.totalTrips || 0,
        acceptsLongTrips: driver.acceptsLongTrips || false,
        documentStatus: driver.documentStatus || "pending",
        isVerified: driver.isVerified || false,
        role: driver.role,
        isDriver: driver.isDriver,
        documentCount,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching driver profile:", err);
    console.log("=".repeat(70));
    console.log("");
    res.status(500).json({
      message: "Error fetching driver profile",
      error: err.message,
    });
  }
};

// ======================================================================
// 📤 Upload Driver Document
// ======================================================================

/**
 * @desc    Upload driver document (DL, Aadhaar, PAN, etc.)
 * @route   POST /api/driver/uploadDocument
 * @access  Private (Driver)
 *
 * NOTE: multer should be configured to accept the file under field name 'document'
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
      console.log("   ❌ No file uploaded");
      return res.status(400).json({ message: "No file uploaded." });
    }
    const file = req.file;

    // Read incoming fields (may be undefined)
    let { docType, vehicleType, extractedData, docSide } = req.body || {};

    console.log("");
    console.log("=".repeat(70));
    console.log("📤 UPLOAD DRIVER DOCUMENT REQUEST");
    console.log("=".repeat(70));
    console.log(`   User ID: ${userId}`);
    console.log(`   Document Type: ${docType}`);
    console.log(`   Vehicle Type: ${vehicleType}`);
    console.log(`   Document Side: ${docSide || "front"}`);
    console.log(`   File: ${file.originalname || "No file"}`);
    console.log("=".repeat(70));

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
      // If parsing fails, fallback to empty object and continue
      console.warn(
        "⚠️ extractedData JSON parse failed, storing empty object:",
        e.message
      );
      parsedExtracted = {};
    }

    // Normalize docType, vehicleType and side for consistent storage/validation
    const docTypeNormalized = (docType || "").toString().trim().toLowerCase();
    const vehicleTypeNormalized = (vehicleType || "").toString().trim().toLowerCase();
    const side = (docSide || "front").toString().trim().toLowerCase();

    // Validate required fields
    if (!docTypeNormalized || !vehicleTypeNormalized) {
      console.log("   ❌ Missing required fields");
      return res.status(400).json({
        message: "docType and vehicleType are required.",
      });
    }

    // Validate docType against allowed docs for vehicleType (case-insensitive)
    const requiredDocsLowerMap = {};
    Object.keys(requiredDocs).forEach((k) => {
      requiredDocsLowerMap[k.toString().toLowerCase()] = (
        requiredDocs[k] || []
      ).map((d) => d.toString().toLowerCase());
    });

    const allowedDocs = requiredDocsLowerMap[vehicleTypeNormalized] || [];
    if (allowedDocs.length > 0 && !allowedDocs.includes(docTypeNormalized)) {
      console.log(`   ❌ Invalid docType for ${vehicleTypeNormalized}`);
      return res.status(400).json({
        message: `Invalid docType '${docType}' for vehicleType '${vehicleType}'. Allowed: ${allowedDocs.join(", ")}`,
      });
    }

    // Find user to get phone (for renaming file) and ensure user exists
    const user = await User.findById(userId);
    if (!user) {
      console.log("   ❌ User not found");
      return res.status(404).json({ message: "User not found" });
    }

    // Build a new filename using phone/docType/side to avoid collisions
    const ext = path.extname(file.originalname) || "";
    const safePhone = (user.phone || "unknown").toString().replace(/[^0-9+]/g, "");
    const safeDocType = docTypeNormalized.replace(/\s+/g, "_");
    const newFileName = `${safePhone}.${safeDocType}.${side}${ext}`;
    const newPath = path.join(path.dirname(file.path), newFileName);

    console.log(`   📁 Renaming file to: ${newFileName}`);

    // Rename file synchronously
    try {
      fs.renameSync(file.path, newPath);
    } catch (renameErr) {
      console.error("❌ Failed to rename uploaded file:", renameErr);
      // If rename fails, continue but save original path
    }

    // Check if document already exists for this user/docType/side
    const existingDoc = await DriverDoc.findOne({
      userId: userId.toString(),
      docType: docTypeNormalized,
      side,
    });

    let savedDoc;

    if (existingDoc) {
      // Update existing document
      console.log("   ♻️  Updating existing document");
      existingDoc.url = newPath;
      existingDoc.status = "pending";
      existingDoc.remarks = "";
      existingDoc.extractedData = parsedExtracted;
      existingDoc.vehicleType = vehicleTypeNormalized;
      savedDoc = await existingDoc.save();
    } else {
      // Create new document
      console.log("   ➕ Creating new document");
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
      savedDoc = await newDoc.save();
    }

    // ✅ Recompute user's overall documentStatus + isVerified
    await recomputeDriverDocumentStatus(userId.toString());

    // Optionally return updated driver info for client
    const updatedDriver = await User.findById(userId)
      .select("_id documentStatus isVerified vehicleType")
      .lean();

    console.log(`   ✅ Document saved: ${savedDoc._id}`);
    console.log("=".repeat(70));
    console.log("");

    return res.status(200).json({
      success: true,
      message: `${docTypeNormalized} ${side} uploaded successfully`,
      document: {
        _id: savedDoc._id,
        documentType: savedDoc.docType,
        docType: savedDoc.docType,
        side: savedDoc.side,
        status: savedDoc.status,
        url: savedDoc.url,
        createdAt: savedDoc.createdAt,
      },
      driver: updatedDriver || null,
    });
  } catch (err) {
    console.error("❌ Error uploading driver document:", err);
    console.log("=".repeat(70));
    console.log("");

    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {
        console.error("Error deleting file:", unlinkErr);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// ======================================================================
// 📄 Get Driver Documents
// ======================================================================

/**
 * @desc    Get all documents for a driver
 * @route   GET /api/driver/documents/:driverId
 * @access  Private (Driver)
 */
export const getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;

    console.log("");
    console.log("=".repeat(70));
    console.log("📄 GET DRIVER DOCUMENTS REQUEST");
    console.log("=".repeat(70));
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Requested by: ${req.user?.uid || req.user?.id || "Unknown"}`);
    console.log("=".repeat(70));

    // Validate driver ID
    if (!driverId || driverId === "undefined" || driverId === "null") {
      console.log("   ❌ Invalid driver ID");
      console.log("=".repeat(70));
      console.log("");

      return res.status(400).json({
        success: false,
        message: "Invalid driver ID",
      });
    }

    // Get driver's vehicle type and status
    const driver = await User.findById(driverId)
      .select("vehicleType documentStatus isVerified name phone")
      .lean();

    if (!driver) {
      console.log("   ⚠️  Driver not found in database");
      console.log("=".repeat(70));
      console.log("");

      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    const vehicleType = driver.vehicleType || null;

    // ✅ Get documents using userId as string
    const docs = await DriverDoc.find({ 
      userId: driverId.toString(),
      imageDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    console.log(`   Driver: ${driver.name} (${driver.phone})`);
    console.log(`   Vehicle Type: ${vehicleType || "Not set"}`);
    console.log(`   Document Status: ${driver.documentStatus || "pending"}`);
    console.log(`   Found ${docs.length} documents`);

    const documentStatus = driver.documentStatus || "pending";
    const isVerified = driver.isVerified || false;

    // ✅ Handle "no documents" case carefully
    if (!docs || docs.length === 0) {
      console.log(
        `   ℹ️  No documents found. Driver status: ${documentStatus}, isVerified: ${isVerified}`
      );

      // If driver is already approved+verified, return 200 with empty docs
      if (documentStatus === "approved" && isVerified) {
        console.log(
          "   ✅ Driver is APPROVED but has 0 documents. Returning 200 with empty docs."
        );
        console.log("=".repeat(70));
        console.log("");

        return res.status(200).json({
          success: true,
          message: "Driver approved, but no documents stored.",
          docs: [],
          vehicleType,
          documentStatus,
          isVerified,
        });
      }

      // For pending / rejected / new drivers
      console.log("   ℹ️  No documents found - returning empty array");
      console.log("=".repeat(70));
      console.log("");

      return res.status(200).json({
        success: true,
        message: "No documents found for this driver.",
        docs: [],
        vehicleType,
        documentStatus,
        isVerified,
      });
    }

    // Build base URL for image access
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // Add full image URLs and format response
    const formattedDocs = docs.map((doc) => {
      let imageUrl = null;

      if (doc.url) {
        // Normalize path
        let cleanPath = doc.url.replace(/\\/g, "/");

        // Extract path starting from 'uploads/'
        const uploadsIndex = cleanPath.indexOf("uploads/");
        if (uploadsIndex !== -1) {
          cleanPath = cleanPath.substring(uploadsIndex);
        } else {
          // Fallback to file basename
          cleanPath = path.basename(cleanPath);
          cleanPath = `uploads/${cleanPath}`;
        }

        imageUrl = `${baseUrl}/${cleanPath}`;
        console.log(`   📸 ${doc.docType} URL: ${imageUrl}`);
      }

      return {
        _id: doc._id,
        documentType: doc.docType, // ✅ Include both for compatibility
        docType: doc.docType,
        side: doc.side || "front",
        status: doc.status,
        url: doc.url,
        imageUrl,
        remarks: doc.remarks || "",
        extractedData: doc.extractedData || null,
        vehicleType: doc.vehicleType,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });

    console.log("   ✅ Documents found:");
    formattedDocs.forEach((doc) => {
      console.log(`      - ${doc.docType} (${doc.side}): ${doc.status}`);
    });
    console.log("=".repeat(70));
    console.log("");

    res.status(200).json({
      success: true,
      message: "Documents retrieved successfully",
      docs: formattedDocs,
      vehicleType,
      documentStatus,
      isVerified,
    });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    console.log("=".repeat(70));
    console.log("");

    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// ======================================================================
// 🔄 Resend Driver Document
// ======================================================================

/**
 * @desc    Mark document for re-upload (reset to pending)
 * @route   POST /api/driver/documents/:docId/resend
 * @access  Private (Driver)
 */
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
      success: true,
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

// ======================================================================
// 👤 Get Driver By ID
// ======================================================================

/**
 * @desc    Get driver details by ID
 * @route   GET /api/driver/:driverId
 * @access  Private (Driver)
 */
export const getDriverById = async (req, res) => {
  try {
    const { driverId } = req.params;

    console.log("");
    console.log("=".repeat(70));
    console.log("👤 GET DRIVER BY ID REQUEST");
    console.log("=".repeat(70));
    console.log(`   Driver ID: ${driverId}`);
    console.log("=".repeat(70));

    const driver = await User.findById(driverId).select("-__v").lean();

    if (!driver) {
      console.log("   ❌ Driver not found");
      console.log("=".repeat(70));
      console.log("");

      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log(`   ✅ Driver found: ${driver.name} (${driver.phone})`);
    console.log("=".repeat(70));
    console.log("");

    res.status(200).json({
      success: true,
      driver: {
        ...driver,
        id: driver._id.toString(),
        lat: driver.location?.coordinates?.[1] || 0,
        lng: driver.location?.coordinates?.[0] || 0,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching driver details:", err);
    console.log("=".repeat(70));
    console.log("");

    res.status(500).json({
      success: false,
      message: "Error fetching driver details",
      error: err.message,
    });
  }
};

// ======================================================================
// ✏️ Update Document Status (Admin)
// ======================================================================

/**
 * @desc    Update document status (Admin only)
 * @route   PATCH /api/driver/documents/:docId/status
 * @access  Private (Admin)
 */
export const updateDocumentStatus = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks } = req.body;

    console.log("");
    console.log("=".repeat(70));
    console.log("✏️  UPDATE DOCUMENT STATUS REQUEST");
    console.log("=".repeat(70));
    console.log(`   Document ID: ${docId}`);
    console.log(`   New Status: ${status}`);
    console.log(`   Remarks: ${remarks || "None"}`);
    console.log(`   Updated by: ${req.user?.uid || req.user?.id}`);
    console.log("=".repeat(70));

    // Validate status
    if (!["pending", "approved", "rejected", "verified"].includes(status)) {
      console.log("   ❌ Invalid status value");
      console.log("=".repeat(70));
      console.log("");

      return res.status(400).json({
        success: false,
        message: "Invalid status. Must be: pending, approved, rejected, or verified",
      });
    }

    // Update document
    const doc = await DriverDoc.findByIdAndUpdate(
      docId,
      {
        status,
        remarks: remarks || "",
      },
      { new: true }
    );

    if (!doc) {
      console.log("   ❌ Document not found");
      console.log("=".repeat(70));
      console.log("");

      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    console.log(
      `   ✅ Document updated: ${doc.docType} (${doc.side}) -> ${doc.status}`
    );

    // ✅ Use recomputeDriverDocumentStatus for consistency
    await recomputeDriverDocumentStatus(doc.userId.toString());

    // Get updated driver status
    const updatedDriver = await User.findById(doc.userId)
      .select("documentStatus isVerified")
      .lean();

    console.log(`   📊 Driver status: ${updatedDriver?.documentStatus}`);
    console.log(`   ✅ Is verified: ${updatedDriver?.isVerified}`);
    console.log("=".repeat(70));
    console.log("");

    res.status(200).json({
      success: true,
      message: "Document status updated successfully",
      document: {
        _id: doc._id,
        documentType: doc.docType,
        docType: doc.docType,
        side: doc.side,
        status: doc.status,
        remarks: doc.remarks,
        updatedAt: doc.updatedAt,
      },
      driverStatus: updatedDriver?.documentStatus,
      isVerified: updatedDriver?.isVerified,
    });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    console.log("=".repeat(70));
    console.log("");

    res.status(500).json({
      success: false,
      message: "Failed to update document status",
      error: err.message,
    });
  }
};