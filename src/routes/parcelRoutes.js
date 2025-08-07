import express from 'express';
import multer from 'multer';
import path from 'path';
import { estimateParcel, createParcel } from '../controllers/parcelController.js';

const router = express.Router();

// ✅ Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Folder where images will be saved
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`); // Unique filename
  },
});

// ✅ File filter (images only)
const fileFilter = (req, file, cb) => {
    console.log("📦 Received file type:", file.mimetype); // Add this

  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

const upload = multer({ storage, fileFilter });

// ✅ Estimate parcel cost
router.post('/estimate', estimateParcel);

// ✅ Create parcel (with photo upload)
router.post('/create', upload.single('parcelPhoto'), createParcel);

export default router;
