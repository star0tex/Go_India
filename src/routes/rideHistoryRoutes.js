import express from "express";
import {
  saveRideHistory,
  getRecentRides
} from "../controllers/rideHistoryController.js";

import { protect } from "../middlewares/authMiddleware.js"; // ✅ import

const router = express.Router();

router.post("/ride-history", protect, saveRideHistory);
router.get("/ride-history", protect, getRecentRides);

export default router;
