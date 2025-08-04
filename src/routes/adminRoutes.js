// src/routes/adminRoutes.js

import express from "express";
import {
  getDriverDocuments,
  verifyDriverDocument,
  getTripDetails,
  manualAssignDriver,
  sendPushToUsers,
} from "../controllers/adminController.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";

const router = express.Router();

/**
 * @route   GET /api/admin/trip/:tripId
 * @desc    Fetch trip + driver + customer info
 * @access  Private (Admin only)
 */
router.get("/trip/:tripId", protect, adminOnly, getTripDetails);

/**
 * @route   POST /api/admin/manual-assign
 * @desc    Admin manually assigns a driver to a trip
 * @access  Private (Admin only)
 */
router.post("/manual-assign", protect, adminOnly, manualAssignDriver);

/**
 * @route   POST /api/admin/send-fcm
 * @desc    Admin sends push notification to users (offers, updates, etc.)
 * @access  Private (Admin only)
 */
router.post("/send-fcm", protect, adminOnly, sendPushToUsers);

/**
 * @route   GET /api/admin/documents/:driverId
 * @desc    Fetch all uploaded documents by a specific driver
 * @access  Private (Admin only)
 */
router.get("/documents/:driverId", protect, adminOnly, getDriverDocuments);

/**
 * @route   PUT /api/admin/verifyDocument/:docId
 * @desc    Verify or reject a specific document with optional remarks
 * @access  Private (Admin only)
 */
router.put("/verifyDocument/:docId", protect, adminOnly, verifyDriverDocument);

export default router;
