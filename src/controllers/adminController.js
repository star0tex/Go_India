import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Rate from "../models/Rate.js";
import DriverDoc from "../models/DriverDoc.js";
import Notification from "../models/Notification.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";
import { verifyAdminToken } from "../middlewares/adminAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
export const getAllFareRates = async (req, res) => {
  try {
    const rates = await Rate.find({}).sort({ state: 1, city: 1, vehicleType: 1 });
    res.status(200).json({ message: "Fare rates fetched successfully", rates });
  } catch (err) {
    console.error("❌ Error fetching fare rates:", err);
    res.status(500).json({ message: "Server error while fetching fare rates." });
  }
};

/**
 * ✏️ Update a specific fare rate
 * PUT /api/admin/fare/update/:id
 */
export const updateFareRate = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Optional validation for safety
    if (updates.baseFare < 0 || updates.perKm < 0) {
      return res.status(400).json({ message: "Invalid fare values." });
    }

    const rate = await Rate.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!rate) return res.status(404).json({ message: "Rate not found." });

    res.status(200).json({ message: "Fare rate updated successfully", rate });
  } catch (err) {
    console.error("❌ Error updating fare rate:", err);
    res.status(500).json({ message: "Server error while updating fare rate." });
  }
};

/**
 * ➕ Add new rate (for new city/vehicle)
 * POST /api/admin/fare/create
 */
export const createFareRate = async (req, res) => {
  try {
    const rate = await Rate.create(req.body);
    res.status(201).json({ message: "New fare rate added successfully", rate });
  } catch (err) {
    console.error("❌ Error creating new fare rate:", err);
    res.status(500).json({ message: "Server error while creating rate." });
  }
};

/**
 * ❌ Delete fare rate
 * DELETE /api/admin/fare/delete/:id
 */
export const deleteFareRate = async (req, res) => {
  try {
    const { id } = req.params;
    const rate = await Rate.findByIdAndDelete(id);
    if (!rate) return res.status(404).json({ message: "Rate not found." });

    res.status(200).json({ message: "Fare rate deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting fare rate:", err);
    res.status(500).json({ message: "Server error while deleting fare rate." });
  }
};
// ======================================================================
// 📊 Dashboard Stats
// ======================================================================
export const getDashboardStats = async (req, res) => {
  try {
    const totalTrips = await Trip.countDocuments();
    const completedTrips = await Trip.countDocuments({ status: "completed" });
    const ongoingTrips = await Trip.countDocuments({ status: "ongoing" });
    const cancelledTrips = await Trip.countDocuments({ status: "cancelled" });

    const totalUsers = await User.countDocuments();
    const totalDrivers = await User.countDocuments({ isDriver: true });
    const totalCustomers = await User.countDocuments({ isDriver: false });

    const pendingDocs = await DriverDoc.countDocuments({ status: "pending" });
    const verifiedDocs = await DriverDoc.countDocuments({ status: "verified" });
    const rejectedDocs = await DriverDoc.countDocuments({ status: "rejected" });

    res.status(200).json({
      message: "Dashboard stats fetched successfully",
      stats: {
        trips: {
          total: totalTrips,
          completed: completedTrips,
          ongoing: ongoingTrips,
          cancelled: cancelledTrips,
        },
        users: {
          total: totalUsers,
          drivers: totalDrivers,
          customers: totalCustomers,
        },
        documents: {
          pending: pendingDocs,
          verified: verifiedDocs,
          rejected: rejectedDocs,
        },
      },
    });
  } catch (err) {
    console.error("❌ Dashboard stats error:", err);
    res.status(500).json({ message: "Server error while fetching stats." });
  }
};

// ======================================================================
// 👥 Users: Drivers & Customers
// ======================================================================
export const getAllDrivers = async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true }).select("-password");
    res.status(200).json({ message: "Drivers fetched successfully", drivers });
  } catch (err) {
    console.error("❌ Error fetching drivers:", err);
    res.status(500).json({ message: "Server error while fetching drivers." });
  }
};

export const getAllCustomers = async (req, res) => {
  try {
    const customers = await User.find({ isDriver: false }).select("-password");
    res.status(200).json({ message: "Customers fetched successfully", customers });
  } catch (err) {
    console.error("❌ Error fetching customers:", err);
    res.status(500).json({ message: "Server error while fetching customers." });
  }
};

export const blockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: true });
    res.status(200).json({ message: "Driver blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking driver:", err);
    res.status(500).json({ message: "Error blocking driver." });
  }
};

export const unblockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: false });
    res.status(200).json({ message: "Driver unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking driver:", err);
    res.status(500).json({ message: "Error unblocking driver." });
  }
};

export const blockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: true });
    res.status(200).json({ message: "Customer blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking customer:", err);
    res.status(500).json({ message: "Error blocking customer." });
  }
};

export const unblockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: false });
    res.status(200).json({ message: "Customer unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking customer:", err);
    res.status(500).json({ message: "Error unblocking customer." });
  }
};

// ======================================================================
// 🚘 Trips
// ======================================================================
export const getAllTrips = async (req, res) => {
  try {
    const trips = await Trip.find({})
      .populate("customerId", "name phone")
      .populate("assignedDriver", "name phone")
      .sort({ createdAt: -1 });
    res.status(200).json({ message: "Trips fetched successfully", trips });
  } catch (err) {
    console.error("❌ Error fetching trips:", err);
    res.status(500).json({ message: "Server error while fetching trips." });
  }
};

export const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const customer = await User.findById(trip.customerId).lean();
    const driver = trip.assignedDriver ? await User.findById(trip.assignedDriver).lean() : null;

    res.status(200).json({
      trip,
      customer: customer
        ? { name: customer.name, phone: customer.phone, address: customer.address || "N/A" }
        : null,
      driver: driver
        ? { name: driver.name, phone: driver.phone, license: driver.license || "N/A" }
        : null,
    });
  } catch (err) {
    console.error("❌ Trip detail fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const manualAssignDriver = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const driver = await User.findById(driverId);
    if (!driver || !driver.isDriver)
      return res.status(404).json({ message: "Driver not found or invalid" });

    trip.assignedDriver = driverId;
    trip.status = "assigned";
    await trip.save();

    if (driver.fcmToken) {
      await sendToDriver(driver.fcmToken, "New Trip Assigned", "You have a new trip assignment.");
    }

    res.status(200).json({ message: "Driver assigned successfully", trip });
  } catch (err) {
    console.error("❌ Manual assign error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const markTripCompleted = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "completed" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip marked as completed", trip });
  } catch (err) {
    console.error("❌ Error marking trip completed:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const cancelTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "cancelled" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip cancelled successfully", trip });
  } catch (err) {
    console.error("❌ Error cancelling trip:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 📨 Push Notifications (WITH STORAGE)
// ======================================================================
export const sendPushToUsers = async (req, res) => {
  try {
    const { title, body, role, type = "general" } = req.body;
    const filter = role ? { isDriver: role === "driver" } : {};
    const users = await User.find(filter);

    let count = 0;
    const notifications = [];

    for (const user of users) {
      // Store notification in database
      notifications.push({
        userId: user._id,
        title,
        body,
        type,
        isRead: false,
      });

      // Send push notification
      if (user.fcmToken) {
        if (role === "driver") await sendToDriver(user.fcmToken, title, body);
        else await sendToCustomer(user.fcmToken, title, body);
        count++;
      }
    }

    // Bulk insert notifications
    await Notification.insertMany(notifications);

    res.status(200).json({ 
      message: `Push sent to ${count} user(s) and stored ${notifications.length} notifications.` 
    });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ message: "Failed to send push." });
  }
};

// 🆕 Individual Push Notification (WITH STORAGE)
export const sendPushToIndividual = async (req, res) => {
  try {
    const { title, body, userId, type = "general" } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Store notification
    await Notification.create({
      userId: user._id,
      title,
      body,
      type,
      isRead: false,
    });

    // Send push notification
    if (user.fcmToken) {
      if (user.isDriver) {
        await sendToDriver(user.fcmToken, title, body);
      } else {
        await sendToCustomer(user.fcmToken, title, body);
      }
    }

    res.status(200).json({ message: `Push sent and stored for ${user.name}` });
  } catch (err) {
    console.error("❌ Push error (individual):", err);
    res.status(500).json({ message: "Failed to send push." });
  }
};

// ======================================================================
// 🔔 Notification Management
// ======================================================================

// Get user's notifications
export const getUserNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, page = 1 } = req.query;

    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const unreadCount = await Notification.countDocuments({ 
      userId, 
      isRead: false 
    });

    res.status(200).json({
      message: "Notifications fetched successfully",
      notifications,
      unreadCount,
    });
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({ message: "Server error while fetching notifications." });
  }
};

// Mark notification as read
export const markNotificationAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findByIdAndUpdate(
      notificationId,
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.status(200).json({ 
      message: "Notification marked as read", 
      notification 
    });
  } catch (err) {
    console.error("❌ Error marking notification as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Mark all notifications as read
export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const { userId } = req.params;
    
    await Notification.updateMany(
      { userId, isRead: false },
      { isRead: true }
    );

    res.status(200).json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("❌ Error marking all as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Delete notification
export const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findByIdAndDelete(notificationId);
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.status(200).json({ message: "Notification deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting notification:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 📄 Documents
// ======================================================================
export const getPendingDocuments = async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const documents = await DriverDoc.find({ status: "pending" })
      .populate("userId", "name email")
      .sort({ createdAt: 1 });

    // Add full public image URL for frontend
    const docsWithImageUrl = documents.map((doc) => {
      const rawPath = doc.url?.replace(/\\/g, "/") || null; // normalize Windows slashes
      const fullUrl = rawPath ? `${baseUrl}/${rawPath}` : null;

      return {
        ...doc.toObject(),
        imageUrl: fullUrl,
      };
    });

    res.status(200).json({
      message: "Pending documents fetched successfully.",
      documents: docsWithImageUrl,
    });
  } catch (err) {
    console.error("❌ Error fetching pending documents:", err);
    res.status(500).json({ message: "Server error." });
  }
};

// =====================================================
// 🧪 TEST ENDPOINT - Add this function
// =====================================================
export const testImageAccess = async (req, res) => {
  try {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    
    console.log('🧪 Testing image access...');
    console.log('📁 Uploads directory:', uploadsDir);
    
    // Check if uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      return res.status(404).json({
        error: 'Uploads directory does not exist',
        path: uploadsDir,
        cwd: process.cwd()
      });
    }
    
    // List all files in uploads directory
    const files = fs.readdirSync(uploadsDir);
    
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    
    const fileDetails = files.map(file => {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      
      return {
        filename: file,
        relativePath: `uploads/${file}`,
        fullPath: filePath,
        url: `${baseUrl}/uploads/${file}`,
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
        created: stats.birthtime,
        modified: stats.mtime
      };
    });
    
    res.status(200).json({
      success: true,
      message: 'Upload directory accessible',
      uploadsDir,
      baseUrl,
      totalFiles: files.length,
      files: fileDetails
    });
  } catch (err) {
    console.error('❌ Test endpoint error:', err);
    res.status(500).json({
      error: 'Error accessing uploads directory',
      message: err.message,
      stack: err.stack
    });
  }
};

// Fixed getDriverDocuments in adminController.js
export const getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    console.log(`\n📋 Fetching documents for driver: ${driverId}`);
    console.log(`🌐 Base URL: ${baseUrl}`);
    
    const documents = await DriverDoc.find({ userId: driverId }).lean();
    
    console.log(`📄 Found ${documents.length} documents in database`);

    const docsWithImageUrl = documents.map((doc, index) => {
      console.log(`\n  Document ${index + 1}/${documents.length}:`);
      console.log(`    ID: ${doc._id}`);
      console.log(`    Type: ${doc.docType}`);
      
      let imageUrl = null;
      let fileExists = false;
      let debugInfo = {};
      
      if (doc.url) {
        // Original path from database
        const originalPath = doc.url;
        console.log(`    Original DB path: ${originalPath}`);
        
        // Normalize path: convert backslashes to forward slashes
        let cleanPath = originalPath.replace(/\\/g, "/");
        console.log(`    After normalize: ${cleanPath}`);
        
        // Extract path starting from 'uploads/'
        const uploadsIndex = cleanPath.indexOf('uploads/');
        if (uploadsIndex !== -1) {
          cleanPath = cleanPath.substring(uploadsIndex);
          console.log(`    After extract: ${cleanPath}`);
        } else if (!cleanPath.startsWith('uploads/')) {
          // If path doesn't contain 'uploads/', try to construct it
          const filename = path.basename(cleanPath);
          cleanPath = `uploads/${filename}`;
          console.log(`    Reconstructed: ${cleanPath}`);
        }
        
        // Check if file exists on disk
        const fullFilePath = path.join(process.cwd(), cleanPath);
        fileExists = fs.existsSync(fullFilePath);
        console.log(`    File exists: ${fileExists}`);
        console.log(`    Full path: ${fullFilePath}`);
        
        // Construct URL
        imageUrl = `${baseUrl}/${cleanPath}`;
        console.log(`    Final URL: ${imageUrl}`);
        
        debugInfo = {
          originalPath,
          cleanPath,
          fullFilePath,
          fileExists,
          fileSize: fileExists ? fs.statSync(fullFilePath).size : null
        };
        
        return {
          ...doc,
          imageUrl,
          url: cleanPath,
          _debug: debugInfo
        };
      }
      
      console.log(`    ⚠️ No URL found in database`);
      
      return {
        ...doc,
        imageUrl: null,
        url: null,
        _debug: {
          error: 'No URL in document record'
        }
      };
    });

    const uploadsDir = path.join(process.cwd(), 'uploads');
    const uploadsDirExists = fs.existsSync(uploadsDir);
    
    console.log(`\n✅ Response prepared:`);
    console.log(`   Documents with images: ${docsWithImageUrl.filter(d => d.imageUrl).length}`);
    console.log(`   Files exist on disk: ${docsWithImageUrl.filter(d => d._debug?.fileExists).length}`);

    res.status(200).json({
      message: "Documents retrieved successfully.",
      docs: docsWithImageUrl,
      _debug: {
        baseUrl,
        uploadsDirExists,
        uploadsDir,
        totalDocs: documents.length,
        docsWithUrls: docsWithImageUrl.filter(d => d.imageUrl).length,
        filesExist: docsWithImageUrl.filter(d => d._debug?.fileExists).length
      }
    });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    res.status(500).json({ 
      message: "Server error",
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

export const getDocumentById = async (req, res) => {
  try {
    const { docId } = req.params;
    const document = await DriverDoc.findById(docId).populate("userId", "name email");
    if (!document) return res.status(404).json({ message: "Document not found." });

    res.status(200).json({ message: "Document details fetched successfully.", document });
  } catch (err) {
    console.error("❌ Error fetching document by ID:", err);
    res.status(500).json({ message: "Server error." });
  }
};

export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks } = req.body;

    if (!["approved", "rejected", "verified"].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'approved' or 'rejected'." });
    }

    const updatedDoc = await DriverDoc.findByIdAndUpdate(
      docId,
      { status, remarks },
      { new: true }
    );
    if (!updatedDoc) return res.status(404).json({ message: "Document not found." });

    res.status(200).json({ message: `Document ${status} successfully.`, document: updatedDoc });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    res.status(500).json({ message: "Server error while verifying document." });
  }
};
// ======================================================================
// 🔐 Admin Login
// ======================================================================
export const adminLogin = async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1d" });
    return res.status(200).json({ token });
  } else {
    return res.status(401).json({ message: "Invalid email or password." });
  }
};