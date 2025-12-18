// src/middlewares/authMiddleware.js
import admin from "../utils/firebase.js";
import User from "../models/User.js";

// =====================================================
// 🔐 Protect normal users (Driver / Customer)
// =====================================================
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    const token = authHeader.split(" ")[1];

    console.log("🔐 Verifying Firebase token...");

    const decodedToken = await admin.auth().verifyIdToken(token);

    // ✅ Check for the standard claim first, then fall back to custom claim
    const phoneInToken =
      decodedToken.phone_number ||
      (decodedToken.phone ? `+91${decodedToken.phone}` : null);

    if (!phoneInToken) {
      return res.status(401).json({
        success: false,
        message: "Phone number not found in token",
      });
    }

    console.log("🔐 Token verified for:", phoneInToken);

    // Normalize phone number (last 10 digits)
    const phone = phoneInToken.replace("+91", "").slice(-10);

    const user = await User.findOne({ phone });

    if (!user) {
      console.log(`❌ User not found in DB for phone: ${phone}`);
      return res.status(401).json({
        success: false,
        message: "User not found in DB",
      });
    }

    console.log(`✅ User authenticated:`);
    console.log(`   MongoDB ID: ${user._id}`);
    console.log(`   Phone: ${user.phone}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Vehicle Type: ${user.vehicleType || "not set"}`);

    // =====================================================
    // ✅ IMPORTANT: Attach both Firebase & MongoDB user info
    // =====================================================
    req.user = {
      ...decodedToken,

      // 🔑 MongoDB identity (ALL formats for compatibility)
      _id: user._id,       // ✅ REQUIRED (fixes notification bug)
      id: user._id,        // legacy support
      mongoId: user._id,   // clarity

      // User info from database
      phone: user.phone,
      role: user.role,
      isDriver: user.isDriver,
      vehicleType: user.vehicleType,
    };

    next();
  } catch (error) {
    console.error("❌ Auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
      error: error.message,
    });
  }
};

// =====================================================
// 🔐 Verify Firebase Token (raw, no DB lookup)
// =====================================================
export const verifyFirebaseToken = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Missing Authorization header",
    });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // 🔑 Attach decoded Firebase user
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid Firebase token",
      error: err.message,
    });
  }
};

// =====================================================
// 🔐 Admin only middleware
// =====================================================
export const adminOnly = (req, res, next) => {
  try {
    // Hardcoded admin phone numbers (consider moving to env/config)
    const adminPhoneNumbers = [
      "+919999999999",
      "+918888888888",
    ];

    const userPhone = req.user.phone_number || req.user.phone;

    if (!adminPhoneNumbers.includes(userPhone)) {
      return res.status(403).json({
        success: false,
        message: "Admin access only",
      });
    }

    next();
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Error checking admin rights",
      error: err.message,
    });
  }
};// src/middlewares/multer.js
import multer from "multer";
import path from "path";
import fs from "fs";

// ─────────────────────────────────────────────
// 📁 1. Disk storage for driver documents with phone number
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/documents";

    // ✅ Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    cb(null, dir);
  },
  filename: (req, file, cb) => {
    try {
      // Get phone number from authenticated user or request body
      const phoneNumber = req.user?.phoneNumber || req.body.phoneNumber;
      const docType = req.body.docType || 'document';
      const docSide = req.body.docSide || 'unknown';
      
      if (!phoneNumber) {
        return cb(new Error("Phone number is required"));
      }

      // Get file extension
      const ext = path.extname(file.originalname);
      
      // Format: phoneNumber_docType_side.ext
      // Example: 8331134126_RC_front.jpg
      const filename = `${phoneNumber}_${docType.toUpperCase()}_${docSide}${ext}`;
      
      console.log(`📝 Saving document as: ${filename}`);
      cb(null, filename);
    } catch (error) {
      console.error("❌ Error generating filename:", error);
      cb(error);
    }
  },
});

export const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: (req, file, cb) => {
    console.log("Received file type:", file.mimetype); 
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WEBP files are allowed."));
    }
  },
});

// ─────────────────────────────────────────────
// 🧠 2. In-memory buffer for Cloudinary uploads (profile photos)
const profilePhotoStorage = multer.memoryStorage();

export const uploadProfilePhoto = multer({
  storage: profilePhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    console.log("Received file type:", file.mimetype);
    const allowedTypes = ["image/jpeg", "image/png"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG and PNG image files are allowed."));
    }
  },
});