// routes/userRoutes.js
import express from "express";
import {
  createUser,
  getUser,
  updateUser,
  deleteUser,
} from "../controllers/userController.js";

const router = express.Router();

// POST /api/user
router.post("/", createUser);

// GET /api/user/:phone
router.get("/:phone", getUser);

// PUT /api/user/:phone
router.put("/:phone", updateUser);

// DELETE /api/user/:phone
router.delete("/:phone", deleteUser);

export default router;
