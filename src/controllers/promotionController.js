// controllers/promotionController.js
import Promotion from '../models/Promotion.js';
import cloudinary from '../utils/cloudinary.js'; // ✅ Use your existing cloudinary

/**
 * Upload new promotion to Cloudinary
 * POST /api/admin/promotions/upload
 */
export const uploadPromotion = async (req, res) => {
  try {
    console.log('📸 Upload attempt received');
    console.log('File:', req.file);
    console.log('Body:', req.body);

    if (!req.file) {
      console.log('❌ No file in request');
      return res.status(400).json({ message: 'No image file provided' });
    }

    const { title } = req.body;
    if (!title) {
      // Delete from Cloudinary if validation fails
      if (req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.status(400).json({ message: 'Title is required' });
    }

    // ✅ Cloudinary automatically provides the permanent URL
    const imageUrl = req.file.path; // Full Cloudinary URL (permanent!)
    const cloudinaryId = req.file.filename; // Cloudinary public_id for deletion

    console.log('🌐 Cloudinary URL:', imageUrl);
    console.log('🆔 Cloudinary ID:', cloudinaryId);

    // Get the highest order number and increment
    const maxOrder = await Promotion.findOne().sort('-order').select('order');
    const order = maxOrder ? maxOrder.order + 1 : 0;

    const promotion = await Promotion.create({
      title,
      imageUrl, // ✅ Permanent Cloudinary URL - never breaks!
      imagePath: cloudinaryId, // Store Cloudinary ID for deletion
      order,
      isActive: true,
    });

    console.log('✅ Promotion created:', promotion._id);
    console.log('✅ Image URL (permanent):', imageUrl);

    res.status(201).json({
      message: 'Promotion uploaded successfully',
      promotion,
    });
  } catch (err) {
    console.error('❌ Error uploading promotion:', err);
    console.error('Stack:', err.stack);
    
    // Delete from Cloudinary on error
    if (req.file && req.file.filename) {
      try {
        await cloudinary.uploader.destroy(req.file.filename);
        console.log('🗑️ Cleaned up Cloudinary file after error');
      } catch (deleteErr) {
        console.error('Error deleting from Cloudinary:', deleteErr);
      }
    }
    res.status(500).json({ 
      message: 'Server error while uploading promotion',
      error: err.message 
    });
  }
};

/**
 * Get all promotions (Admin)
 * GET /api/admin/promotions
 */
export const getAllPromotions = async (req, res) => {
  try {
    console.log('📋 Fetching all promotions');
    
    const promotions = await Promotion.find({}).sort({ order: 1, createdAt: -1 });
    
    console.log(`✅ Found ${promotions.length} promotions`);
    
    res.status(200).json({
      message: 'Promotions fetched successfully',
      promotions,
    });
  } catch (err) {
    console.error('❌ Error fetching promotions:', err);
    res.status(500).json({ message: 'Server error while fetching promotions' });
  }
};

/**
 * Get active promotions (Customer App)
 * GET /api/promotions/active
 */
export const getActivePromotions = async (req, res) => {
  try {
    console.log('📱 Customer app fetching active promotions');
    
    const promotions = await Promotion.find({ isActive: true })
      .sort({ order: 1 })
      .select('title imageUrl order');

    console.log(`✅ Returning ${promotions.length} active promotions`);

    // Increment view count for each promotion
    const promotionIds = promotions.map(p => p._id);
    await Promotion.updateMany(
      { _id: { $in: promotionIds } },
      { $inc: { viewCount: 1 } }
    );

    res.status(200).json({
      message: 'Active promotions fetched successfully',
      promotions,
    });
  } catch (err) {
    console.error('❌ Error fetching active promotions:', err);
    res.status(500).json({ message: 'Server error while fetching promotions' });
  }
};

/**
 * Toggle promotion active status
 * PUT /api/admin/promotions/:id/toggle
 */
export const togglePromotionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    console.log(`🔄 Toggling promotion ${id} to ${isActive ? 'active' : 'inactive'}`);

    const promotion = await Promotion.findByIdAndUpdate(
      id,
      { isActive },
      { new: true }
    );

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    console.log('✅ Promotion status updated');

    res.status(200).json({
      message: `Promotion ${isActive ? 'activated' : 'deactivated'} successfully`,
      promotion,
    });
  } catch (err) {
    console.error('❌ Error toggling promotion status:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Delete promotion from database AND Cloudinary
 * DELETE /api/admin/promotions/:id
 */
export const deletePromotion = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Attempting to delete promotion ${id}`);
    
    const promotion = await Promotion.findById(id);

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    // ✅ Delete image from Cloudinary
    try {
      if (promotion.imagePath) {
        const result = await cloudinary.uploader.destroy(promotion.imagePath);
        console.log('🗑️ Cloudinary deletion result:', result);
        
        if (result.result === 'ok') {
          console.log('✅ Image deleted from Cloudinary:', promotion.imagePath);
        } else {
          console.log('⚠️ Cloudinary deletion status:', result.result);
        }
      }
    } catch (cloudinaryErr) {
      console.error('❌ Error deleting from Cloudinary:', cloudinaryErr);
      // Continue with database deletion even if Cloudinary fails
    }

    // Delete from database
    await Promotion.findByIdAndDelete(id);

    console.log('✅ Promotion deleted from database');

    res.status(200).json({
      message: 'Promotion deleted successfully',
    });
  } catch (err) {
    console.error('❌ Error deleting promotion:', err);
    res.status(500).json({ message: 'Server error while deleting promotion' });
  }
};

/**
 * Update promotion order
 * PUT /api/admin/promotions/:id/order
 */
export const updatePromotionOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { order } = req.body;

    console.log(`🔢 Updating promotion ${id} order to ${order}`);

    const promotion = await Promotion.findByIdAndUpdate(
      id,
      { order },
      { new: true }
    );

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    console.log('✅ Promotion order updated');

    res.status(200).json({
      message: 'Promotion order updated successfully',
      promotion,
    });
  } catch (err) {
    console.error('❌ Error updating promotion order:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Track promotion click
 * POST /api/promotions/:id/click
 */
export const trackPromotionClick = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`👆 Click tracked for promotion ${id}`);
    
    await Promotion.findByIdAndUpdate(id, {
      $inc: { clickCount: 1 }
    });

    res.status(200).json({ message: 'Click tracked' });
  } catch (err) {
    console.error('❌ Error tracking click:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
// Add to promotionController.js
export const cleanupOldPromotions = async (req, res) => {
  try {
    const result = await Promotion.deleteMany({
      imageUrl: { $not: { $regex: /cloudinary\.com/ } }
    });
    
    res.json({
      message: 'Old promotions cleaned up',
      deletedCount: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({ message: 'Cleanup failed', error: err.message });
  }
};