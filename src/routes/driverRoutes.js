import express from "express";
import { uploadDriverProfilePhoto } from "../controllers/driverProfileController.js";
import { uploadDriverDocument, getDriverDocuments, getDriverById } from "../controllers/documentController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { uploadDocument, uploadProfilePhoto } from "../middlewares/multer.js";
import User from "../models/User.js";


const router = express.Router();

// ✅ New route: Get driver by ID
router.get("/:driverId", protect, getDriverById);

// Get driver documents
router.get("/documents/:driverId", protect, getDriverDocuments);

router.post(
  "/uploadProfilePhoto",
  protect,
  uploadProfilePhoto.single("image"),
  uploadDriverProfilePhoto
);

router.post(
  "/uploadDocument",
  protect,
  uploadDocument.single("document"),
  uploadDriverDocument
);

export default router;
