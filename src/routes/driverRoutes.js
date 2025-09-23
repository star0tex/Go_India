import express from "express";
import { uploadDriverProfilePhoto } from "../controllers/driverProfileController.js";
import { uploadDriverDocument, getDriverDocuments, getDriverById } from "../controllers/documentController.js";
import { protect } from "../middlewares/authMiddleware.js"; // ✅ use correct file + export
import { uploadDocument, uploadProfilePhoto } from "../middlewares/multer.js";
import { updateDriverVehicleType } from "../controllers/driverController.js";

const router = express.Router();

// ✅ Use protect here, not authMiddleware
router.post("/setVehicleType", protect, updateDriverVehicleType);

// Get driver by ID
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