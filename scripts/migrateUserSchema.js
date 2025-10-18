// scripts/migrateUserSchema.js
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ✅ Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const migrateUsers = async () => {
  try {
    console.log('🔄 Starting User schema migration...');
    
    // ✅ Verify MONGODB_URI exists
    if (!process.env.MONGO_URI) {
      console.error('');
      console.error('❌ ERROR: MONGODB_URI not found in .env file!');
      console.error('');
      console.error('Please create a .env file in C:\\Go_India-11\\.env with:');
      console.error('MONGO_URI=mongodb+srv://your-connection-string');
      console.error('');
      process.exit(1);
    }
    
    console.log(`📡 Connecting to: ${process.env.MONGO_URI.substring(0, 50)}...`);
    
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    
    // Step 1: Add new fields to all users
    const updateResult = await User.updateMany(
      {},
      {
        $set: {
          currentTripId: null,
          isBusy: false,
          canReceiveNewRequests: false,
          socketId: null,
          rating: 4.8,
          vehicleBrand: null,
          vehicleNumber: null,
          photoUrl: null
        }
      }
    );
    
    console.log(`✅ Migration complete: ${updateResult.modifiedCount} users updated`);
    
    // Step 2: Copy profilePhotoUrl to photoUrl if exists
    const photoCopyResult = await User.updateMany(
      { 
        profilePhotoUrl: { $exists: true, $ne: null },
        photoUrl: null
      },
      [{ $set: { photoUrl: '$profilePhotoUrl' } }]
    );
    
    console.log(`✅ Copied ${photoCopyResult.modifiedCount} photo URLs`);
    
    // Step 3: Verify migration
    const totalUsers = await User.countDocuments();
    const usersWithNewFields = await User.countDocuments({
      currentTripId: { $exists: true },
      isBusy: { $exists: true },
      canReceiveNewRequests: { $exists: true }
    });
    
    console.log('');
    console.log('📊 Migration Summary:');
    console.log(`   Total users: ${totalUsers}`);
    console.log(`   Migrated users: ${usersWithNewFields}`);
    console.log(`   Success rate: ${totalUsers > 0 ? ((usersWithNewFields / totalUsers) * 100).toFixed(2) : 0}%`);
    console.log('');
    
    if (usersWithNewFields === totalUsers) {
      console.log('✅ ✅ ✅ ALL USERS MIGRATED SUCCESSFULLY! ✅ ✅ ✅');
    } else {
      console.warn('⚠️ WARNING: Some users not migrated');
    }
    
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
};

migrateUsers();