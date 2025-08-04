import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// ─────────────────────────────────────────────
// 📁 1. Disk storage for driver documents
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/documents/");
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

export const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and PDF files are allowed."));
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
    const allowedTypes = ["image/jpeg", "image/png"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG and PNG image files are allowed."));
    }
  },
});
