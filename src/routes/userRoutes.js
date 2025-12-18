// routes/userRoutes.js
import express from "express";
import User from '../models/User.js';

import {
  createUser,
  getUser,
  updateUser,
  deleteUser,
  getUserById
} from "../controllers/userController.js";

const router = express.Router();

// =====================================================
// 📱 FCM TOKEN
// =====================================================
router.post('/update-fcm', async (req, res) => {
  try {
    const { phone, fcmToken } = req.body;

    if (!phone || !fcmToken) {
      return res.status(400).json({ 
        message: 'Phone and FCM token are required' 
      });
    }

    // Remove country code if present
    const phoneKey = phone.replace(/^\+91/, "").replace(/^91/, "");

    const user = await User.findOneAndUpdate(
      { phone: phoneKey },
      { 
        fcmToken,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    console.log(`✅ FCM token updated for ${phoneKey}`);

    res.status(200).json({
      success: true,
      message: 'FCM token updated successfully',
      userId: user._id
    });

  } catch (error) {
    console.error('❌ Update FCM token error:', error);
    res.status(500).json({ 
      message: 'Failed to update FCM token',
      error: error.message 
    });
  }
});

// =====================================================
// 👤 USER CRUD
// =====================================================

// POST /api/user - Create user
router.post("/", createUser);

// ✅ IMPORTANT: Specific routes MUST come before generic routes
// GET /api/user/id/:id - Get user by ID
router.get("/id/:id", getUserById);

// GET /api/user/:phone - Get user by phone
router.get("/:phone", getUser);

// PUT /api/user/:phone - Update user by phone
router.put("/:phone", updateUser);

// DELETE /api/user/:phone - Delete user by phone
router.delete("/:phone", deleteUser);

export default router;