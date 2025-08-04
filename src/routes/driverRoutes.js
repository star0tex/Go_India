import express from "express";
import { uploadDriverProfilePhoto } from "../controllers/driverProfileController.js";
import { uploadDriverDocument } from "../controllers/documentController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { uploadDocument, uploadProfilePhoto } from "../middlewares/multer.js"; // ✅ custom multer configs

const router = express.Router();

/**
 * @route   POST /api/driver/uploadProfilePhoto
 * @desc    Upload driver's profile picture
 * @access  Private (Driver)
 * @middleware: multer.single("image")
 */
router.post(
  "/uploadProfilePhoto",
  protect,
  uploadProfilePhoto.single("image"), // ✅ use the configured profile photo multer
  uploadDriverProfilePhoto
);

/**
 * @route   POST /api/driver/uploadDocument
 * @desc    Upload driver's document (DL, Aadhaar, etc.)
 * @access  Private (Driver)
 * @middleware: multer.single("document")
 */
router.post(
  "/uploadDocument",
  protect,
  uploadDocument.single("document"), // ✅ use the configured document multer
  uploadDriverDocument
);

export default router;
