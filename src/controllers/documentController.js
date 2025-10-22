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
 * @desc    Get authenticated driver's profile
 * @route   GET /api/driver/profile
 * @access  Private (Driver)
 */
export const getDriverProfile = async (req, res) => {
  try {
    // req.user is populated by your Firebase auth middleware
    const userId = req.user.id || req.user.uid;
    
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // Find user by MongoDB _id
    const driver = await User.findById(userId).lean();

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    // Format the response to match what the Flutter app expects
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
      }
    });
  } catch (err) {
    console.error("❌ Error fetching driver profile:", err);
    res.status(500).json({ 
      message: "Error fetching driver profile", 
      error: err.message 
    });
  }
};
/**
 * Upload driver document (DL, Aadhaar, PAN, etc.)
 * POST /api/driver/uploadDocument
 */
export const uploadDriverDocument = async (req, res) => {
  try {
    const userId = String(req.user.id);
    const { docType, vehicleType, extractedData, docSide } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }
    const file = req.file;

    if (!docType || !vehicleType || !extractedData) {
      return res.status(400).json({ 
        message: "docType, vehicleType, extractedData required" 
      });
    }

    const allowedDocs = requiredDocs[vehicleType.toLowerCase()] || [];
    if (!allowedDocs.includes(docType.toLowerCase())) {
      return res.status(400).json({ 
        message: `Invalid docType for ${vehicleType}` 
      });
    }

    // Get user's phone number
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Rename file with phone number
    const ext = path.extname(file.originalname);
    const side = docSide || "front";
    const newFileName = `${user.phone}.${docType}.${side}${ext}`;
    const newPath = path.join(path.dirname(file.path), newFileName);
    
    // Rename the file
    const fs = await import('fs');
    fs.renameSync(file.path, newPath);

    const newDoc = new DriverDoc({
      userId,
      docType,
      side,
      url: newPath,
      status: "pending",
      remarks: "",
      extractedData,
    });

    await newDoc.save();

    res.status(200).json({
      message: `${docType} ${side} uploaded successfully`,
      document: newDoc,
    });
  } catch (err) {
    console.error("❌ Error uploading driver document:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};/**
 * Get all documents for a driver
 * GET /api/driver/documents/:driverId
 */
// In documentController.js
// src/controllers/documentController.js
export const getDriverDocuments = async (req, res) => {
  const { driverId } = req.params;

  try {
    const docs = await DriverDoc.find({ userId: driverId }).lean();
    
    // Get driver's vehicle type
    const driver = await User.findById(driverId).lean();
    const vehicleType = driver?.vehicleType || null;

    if (!docs || docs.length === 0) {
      return res.status(200).json({ 
        message: "No documents found for this driver.", 
        docs: [],
        vehicleType // Include vehicle type
      });
    }

    res.status(200).json({ 
      docs,
      vehicleType // Include vehicle type
    });
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
