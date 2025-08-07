import path from "path";
import { fileURLToPath } from "url";
import DriverDoc from "../models/DriverDoc.js";
import requiredDocs from "../utils/requiredDocs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @desc    Upload driver document (DL, Aadhaar, PAN, etc.)
 * @route   POST /api/driver/uploadDocument
 * @access  Private (Driver)
 * @notes   Frontend handles OCR using Google ML Kit and sends extracted text
 */
export const uploadDriverDocument = async (req, res) => {
  try {
    const userId = req.user.id; // Set by protect middleware
    const file = req.file;
    const { docType, vehicleType, extractedData } = req.body;

     // 🔍 Add this block for debugging
    console.log("docType:", docType);
    console.log("vehicleType:", vehicleType);
    console.log("extractedData:", extractedData);
    console.log("file received:", file?.originalname || "No file");


    if (!file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    if (!docType || !vehicleType || !extractedData) {
      return res.status(400).json({
        message: "docType, vehicleType, and extractedData are required.",
      });
    }

    // ✅ Validate docType against vehicleType
    const allowedDocs = requiredDocs[vehicleType];
    console.log("allowedDocs for vehicleType:", vehicleType, "=>", allowedDocs);

    if (!allowedDocs || !allowedDocs.includes(docType)) {
      return res.status(400).json({
        message: `Document type '${docType}' is not required for vehicle type '${vehicleType}'.`,
      });
    }

    // ✅ Save document metadata
    const newDoc = new DriverDoc({
      userId,
      docType,
      url: file.path, // Stored locally in uploads/documents/
      status: "pending", // Initial status
      remarks: "",
      extractedData,
    });

    await newDoc.save();

    res.status(200).json({
      message: `${docType} uploaded and saved successfully.`,
      document: newDoc,
    });
  } catch (error) {
    console.error("Error uploading driver document:", error);
    res.status(500).json({ message: "Server error while uploading document." });
  }
};
