// src/routes/authRoutes.js
import express from "express";
import { firebaseLogin } from "../controllers/authController.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/firebase-login", protect, firebaseLogin);

export default router;
