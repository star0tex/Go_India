// routes/promotionRoutes.js
import express from 'express';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../utils/cloudinary.js';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import {
  uploadPromotion,
  getAllPromotions,
  getActivePromotions,
  togglePromotionStatus,
  deletePromotion,
  updatePromotionOrder,
  trackPromotionClick,
} from '../controllers/promotionController.js';

const router = express.Router();

// ✅ Configure Cloudinary Storage (NO local uploads anymore!)
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'go-china/promotions',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 1200, height: 600, crop: 'limit', quality: 'auto' }],
    public_id: (req, file) => `promo-${Date.now()}-${Math.round(Math.random() * 1E9)}`,
  },
});

// ✅ Use ONLY Cloudinary storage
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(file.originalname.toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// =====================================================
// Admin Routes (Protected)
// =====================================================
router.post('/admin/promotions/upload', verifyAdminToken, upload.single('image'), uploadPromotion);
router.get('/admin/promotions', verifyAdminToken, getAllPromotions);
router.put('/admin/promotions/:id/toggle', verifyAdminToken, togglePromotionStatus);
router.put('/admin/promotions/:id/order', verifyAdminToken, updatePromotionOrder);
router.delete('/admin/promotions/:id', verifyAdminToken, deletePromotion);

// =====================================================
// Customer Routes (Public)
// =====================================================
router.get('/promotions/active', getActivePromotions);
router.post('/promotions/:id/click', trackPromotionClick);

export default router;