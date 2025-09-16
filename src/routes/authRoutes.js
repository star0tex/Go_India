// routes/authRoutes.js
import express from "express";
import { firebaseLogin } from "../controllers/authController.js";
import { verifyFirebaseToken } from "../middlewares/authMiddleware.js";

const router = express.Router();

/**
 * @route   POST /api/auth/firebase-login
 * @desc    Firebase login + user auto-create/driver upgrade
 * @access  Private (requires Firebase token)
 */
router.post("/firebase-login", verifyFirebaseToken, firebaseLogin);

export default router;
