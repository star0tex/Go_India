// src/controllers/documentController.js
import path from "path";
import { fileURLToPath } from "url";
import DriverDoc from "../models/DriverDoc.js"; // correct model
import requiredDocs from "../utils/requiredDocs.js";
import User from "../models/User.js"; // ✅ make sure this is at the top

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("📄 documentController loaded"); // debug: confirm file loaded

/**
 * Upload driver document (DL, Aadhaar, PAN, etc.)
 * POST /api/driver/uploadDocument
 */
export const uploadDriverDocument = async (req, res) => {
  try {
    const userId = String(req.user.id);
    const { docType, vehicleType, extractedData, docSide } = req.body;

    // 🔑 Fix: Multer puts file into req.file
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }
    const file = req.file;

    if (!docType || !vehicleType || !extractedData) {
      return res
        .status(400)
        .json({ message: "docType, vehicleType, extractedData required" });
    }

    const allowedDocs = requiredDocs[vehicleType.toLowerCase()] || [];
    if (!allowedDocs.includes(docType.toLowerCase())) {
      return res
        .status(400)
        .json({ message: `Invalid docType for ${vehicleType}` });
    }

    const newDoc = new DriverDoc({
      userId, // ✅ correct link to User
      docType,
      side: docSide || "front", // optional, default front
      url: file.path, // ✅ multer saved path
      status: "pending",
      remarks: "",
      extractedData,
    });

    await newDoc.save();

    res.status(200).json({
      message: `${docType} uploaded successfully`,
      document: newDoc,
    });
  } catch (err) {
    console.error("❌ Error uploading driver document:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
/**
 * Get all documents for a driver
 * GET /api/driver/documents/:driverId
 */
// In documentController.js
// src/controllers/documentController.js
export const getDriverDocuments = async (req, res) => {
  const { driverId } = req.params;

  try {
    // 🔥 Correct model name (DriverDoc not DriverDocument)
    const docs = await DriverDoc.find({ userId: driverId }).lean();

    if (!docs || docs.length === 0) {
      return res.status(200).json({ message: "No documents found for this driver.", docs: [] });
    }

    res.status(200).json({ docs });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    res.status(500).json({ message: "Server error", error: err.message });
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

    res.status(200).json(driver);
  } catch (err) {
    res.status(500).json({
      message: "Error fetching driver details",
      error: err.message,
    });
  }
};
