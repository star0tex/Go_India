//controllers/adminController.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Rate from "../models/Rate.js";
import DriverDoc from "../models/DriverDoc.js";
import Notification from "../models/Notification.js";

// ✅ FCM Helpers (both methods supported)
import { sendFCMNotification } from "../utils/fcmHelper.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";

import { verifyAdminToken } from "../middlewares/adminAuth.js";
import { recomputeDriverDocumentStatus } from "./documentController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ======================================================================
// 💰 Fare Rate Management
// ======================================================================

/**
 * 📋 Get all fare rates
 * GET /api/admin/fare/all
 */
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

/**
 * Get all drivers with formatted photo URLs
 */
export const getAllDrivers = async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true })
      .select(
        "name email phone vehicleType profilePhotoUrl photo profilePic driverPhoto avatar isBlocked"
      );

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const formattedDrivers = drivers.map((d) => {
      const rawPhoto =
        d.profilePhotoUrl ||
        d.photo ||
        d.profilePic ||
        d.driverPhoto ||
        d.avatar ||
        null;

      let finalPhotoUrl = null;

      if (rawPhoto) {
        if (rawPhoto.startsWith("http")) {
          finalPhotoUrl = rawPhoto;
        } else {
          finalPhotoUrl = `${baseUrl}/${rawPhoto.replace(/\\/g, "/")}`;
        }
      }

      return {
        _id: d._id,
        name: d.name,
        email: d.email,
        phone: d.phone,
        vehicleType: d.vehicleType,
        profilePhotoUrl: finalPhotoUrl,
        isBlocked: d.isBlocked,
      };
    });

<<<<<<< HEAD
    res.status(200).json({ 
      message: "Drivers fetched successfully", 
      drivers: formattedDrivers 
    });
=======
    res.status(200).json({ drivers: formattedDrivers });
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
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
    if (!driver || !driver.isDriver) {
      return res.status(404).json({ message: "Driver not found or invalid" });
    }

    trip.assignedDriver = driverId;
    trip.status = "assigned";
    await trip.save();

    // 🔔 Send FCM notification to driver
    if (driver.fcmToken) {
      try {
        // Try using the helper function first
        await sendFCMNotification({
          userId: driver._id,
          token: driver.fcmToken,
          title: "New Trip Assigned",
          body: "You have a new trip assignment",
          type: "trip",
          data: { tripId: trip._id.toString() },
        });
      } catch (fcmError) {
        // Fallback to direct sender
        console.warn("⚠️ FCM helper failed, trying direct sender:", fcmError.message);
        await sendToDriver(driver.fcmToken, "New Trip Assigned", "You have a new trip assignment.");
      }
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

/**
 * 🔧 Helper: Create and Send Notification
 * Saves to DB and sends FCM push
 */
export const createAndSendNotification = async ({
  user,
  title,
  body,
  type = "general",
  imageUrl = null,
  ctaText = null,
  ctaRoute = null,
  data = {},
}) => {
  // ============================
  // 1️⃣ SAVE TO DATABASE (INBOX)
  // ============================
  const notification = await Notification.create({
    userId: user._id,
    role: user.isDriver ? "driver" : "customer",
    title,
    body,
    type,
    imageUrl,
    ctaText,
    ctaRoute,
    data,
    isRead: false,
  });

  // ============================
  // 2️⃣ SEND FCM PUSH (OPTIONAL)
  // ============================
  if (user.fcmToken) {
    try {
      await sendFCMNotification({
        userId: user._id,
        token: user.fcmToken,
        title,
        body,
        data: {
          notificationId: notification._id.toString(),
          type,
          ctaRoute: ctaRoute ?? "",
          imageUrl: imageUrl ?? "",
          ...data,
        },
      });
    } catch (fcmError) {
      console.warn("⚠️ FCM notification failed:", fcmError.message);
      // Fallback to direct sender
      try {
        if (user.isDriver) {
          await sendToDriver(user.fcmToken, title, body);
        } else {
          await sendToCustomer(user.fcmToken, title, body);
        }
      } catch (fallbackError) {
        console.error("❌ Fallback FCM also failed:", fallbackError.message);
      }
    }
  }

  return notification;
};

/**
 * 📤 Send push to all users by role
 * POST /api/admin/push/send
 */
export const sendPushToUsers = async (req, res) => {
  try {
    const { title, body, role, type = "general" } = req.body;

    if (!role) {
      return res.status(400).json({ message: "role is required" });
    }

    const users = await User.find(
      role === "driver" ? { isDriver: true } : { isDriver: false }
    );

    let successCount = 0;
    for (const user of users) {
      try {
        await createAndSendNotification({
          user,
          title,
          body,
          type,
        });
        successCount++;
      } catch (err) {
        console.warn(`⚠️ Failed to notify user ${user._id}:`, err.message);
      }
    }

    res.json({
      success: true,
      message: `Saved + sent to ${successCount}/${users.length} users`,
    });
  } catch (err) {
    console.error("❌ Push error:", err);
    res.status(500).json({ message: "Notification failed" });
  }
};

/**
 * 📤 Send push to individual user
 * POST /api/admin/push/individual
 */
export const sendPushToIndividual = async (req, res) => {
  try {
    const { userId, title, body, type = "general" } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({
        message: "userId, title and body are required",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await createAndSendNotification({
      user,
      title,
      body,
      type,
    });

    res.status(200).json({
      message: `Notification sent to ${user.name} successfully`,
    });
  } catch (err) {
    console.error("❌ sendPushToIndividual error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 🔔 Notification Management
// ======================================================================

/**
 * Get user's notifications (for authenticated user via req.user)
 */
export const getUserNotifications = async (req, res) => {
  try {
    // Support both req.user (authenticated) and req.params.userId (admin access)
    const userId = req.user?._id || req.params.userId;
    const role = req.user?.isDriver ? "driver" : "customer";

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    console.log("🔔 Fetch notifications:", {
      userId: userId.toString(),
      role,
    });

    const { limit = 50, page = 1 } = req.query;

    const query = { userId };
    if (req.user) {
      query.role = role;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const unreadCount = await Notification.countDocuments({
      ...query,
      isRead: false,
    });

    res.status(200).json({
      message: "Notifications fetched successfully",
      notifications,
      unreadCount,
    });
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({
      message: "Server error while fetching notifications.",
    });
  }
};

/**
 * Mark notification as read
 */
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
      notification,
    });
  } catch (err) {
    console.error("❌ Error marking notification as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Mark all notifications as read
 */
export const markAllNotificationsAsRead = async (req, res) => {
  try {
    // Support both req.user (authenticated) and req.params.userId (admin access)
    const userId = req.user?._id || req.params.userId;
    const role = req.user?.isDriver ? "driver" : "customer";

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const query = { userId, isRead: false };
    if (req.user) {
      query.role = role;
    }

    await Notification.updateMany(query, { isRead: true });

    res.status(200).json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("❌ Error marking all as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Delete notification
 */
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

/**
 * Get all pending documents
 */
export const getPendingDocuments = async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const documents = await DriverDoc.find({ status: "pending" })
      .populate("userId", "name email")
      .sort({ createdAt: 1 });

    // Add full public image URL for frontend
    const docsWithImageUrl = documents.map((doc) => {
      const rawPath = doc.url?.replace(/\\/g, "/") || null;
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

/**
 * 🧪 TEST ENDPOINT - Debug image access
 */
export const testImageAccess = async (req, res) => {
  try {
    const uploadsDir = path.join(process.cwd(), "uploads");

    console.log("🧪 Testing image access...");
    console.log("📁 Uploads directory:", uploadsDir);

    // Check if uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      return res.status(404).json({
        error: "Uploads directory does not exist",
        path: uploadsDir,
        cwd: process.cwd(),
      });
    }

    // List all files in uploads directory
    const files = fs.readdirSync(uploadsDir);

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const fileDetails = files.map((file) => {
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
        modified: stats.mtime,
      };
    });

    res.status(200).json({
      success: true,
      message: "Upload directory accessible",
      uploadsDir,
      baseUrl,
      totalFiles: files.length,
      files: fileDetails,
    });
  } catch (err) {
    console.error("❌ Test endpoint error:", err);
    res.status(500).json({
      error: "Error accessing uploads directory",
      message: err.message,
      stack: err.stack,
    });
  }
};

/**
 * Get driver's documents with image URLs
 */
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
        const uploadsIndex = cleanPath.indexOf("uploads/");
        if (uploadsIndex !== -1) {
          cleanPath = cleanPath.substring(uploadsIndex);
          console.log(`    After extract: ${cleanPath}`);
        } else if (!cleanPath.startsWith("uploads/")) {
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
          fileSize: fileExists ? fs.statSync(fullFilePath).size : null,
        };

        return {
          ...doc,
          imageUrl,
          url: cleanPath,
          _debug: debugInfo,
        };
      }

      console.log(`    ⚠️ No URL found in database`);

      return {
        ...doc,
        imageUrl: null,
        url: null,
        _debug: {
          error: "No URL in document record",
        },
      };
    });

    const uploadsDir = path.join(process.cwd(), "uploads");
    const uploadsDirExists = fs.existsSync(uploadsDir);

    console.log(`\n✅ Response prepared:`);
    console.log(`   Documents with images: ${docsWithImageUrl.filter((d) => d.imageUrl).length}`);
    console.log(`   Files exist on disk: ${docsWithImageUrl.filter((d) => d._debug?.fileExists).length}`);

    res.status(200).json({
      message: "Documents retrieved successfully.",
      docs: docsWithImageUrl,
      _debug: {
        baseUrl,
        uploadsDirExists,
        uploadsDir,
        totalDocs: documents.length,
        docsWithUrls: docsWithImageUrl.filter((d) => d.imageUrl).length,
        filesExist: docsWithImageUrl.filter((d) => d._debug?.fileExists).length,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching driver documents:", err);
    res.status(500).json({
      message: "Server error",
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

/**
 * Get document by ID
 */
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

/**
 * Verify/Update driver document status
 */
export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks, extractedData } = req.body;

<<<<<<< HEAD
    if (!["approved", "rejected", "verified"].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'approved', 'rejected', or 'verified'." });
    }

    const updates = { status, remarks };
    if (extractedData && typeof extractedData === "object") {
      updates.extractedData = extractedData;
    }
=======
    if (!["approved", "rejected", "verified"].includes(status))
      return res.status(400).json({ message: "Invalid status." });

    const updates = { status, remarks };
    if (extractedData && typeof extractedData === "object") updates.extractedData = extractedData;

    const updatedDoc = await DriverDoc.findByIdAndUpdate(docId, updates, { new: true });
    if (!updatedDoc) return res.status(404).json({ message: "Document not found." });
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538

    const updatedDoc = await DriverDoc.findByIdAndUpdate(docId, updates, {
      new: true,
    });

    if (!updatedDoc) {
      return res.status(404).json({ message: "Document not found." });
    }

    // 🔥 IMPORTANT: recompute overall driver documentStatus + isVerified
    if (updatedDoc.userId) {
      try {
        await recomputeDriverDocumentStatus(updatedDoc.userId.toString());
      } catch (recomputeErr) {
        console.warn("⚠️ Failed to recompute driver status:", recomputeErr.message);
      }
    }

    // Optional: fetch updated user to show new status in admin UI
    const updatedUser = updatedDoc.userId
      ? await User.findById(updatedDoc.userId)
          .select("_id name phone documentStatus isVerified vehicleType")
          .lean()
      : null;

    return res.status(200).json({
      message: `Document ${status} successfully.`,
      document: updatedDoc,
      driver: updatedUser,
    });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    return res.status(500).json({ message: "Server error while verifying document." });
  }
};

<<<<<<< HEAD
/**
 * 🆕 Delete document image to free backend space
 */
=======
// 🆕 Delete document image to free backend space
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538
export const deleteDriverDocumentImage = async (req, res) => {
  try {
    const { docId } = req.params;
    const doc = await DriverDoc.findById(docId);
    if (!doc) return res.status(404).json({ message: "Document not found." });
    if (!doc.url) return res.status(400).json({ message: "No image stored for this document." });

    let filePath = doc.url.replace(/\\/g, "/");
    const uploadsIndex = filePath.indexOf("uploads/");
<<<<<<< HEAD
    if (uploadsIndex !== -1) {
      filePath = path.join(process.cwd(), filePath.substring(uploadsIndex));
    } else {
      filePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    }
=======
    if (uploadsIndex !== -1)
      filePath = path.join(process.cwd(), filePath.substring(uploadsIndex));
    else filePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted file: ${filePath}`);
<<<<<<< HEAD
    } else {
      console.warn(`⚠️ File not found: ${filePath}`);
    }
=======
    } else console.warn(`⚠️ File not found: ${filePath}`);
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538

    doc.url = null;
    doc.imageDeleted = true;
    doc.imageDeletedAt = new Date();
    await doc.save();

    res.status(200).json({ message: "Document image deleted and DB updated.", doc });
  } catch (err) {
    console.error("❌ Error deleting document image:", err);
    res.status(500).json({ message: "Server error while deleting document image.", error: err.message });
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