import mongoose from 'mongoose';
import User from '../src/models/User.js';
import dotenv from 'dotenv';

dotenv.config();

async function addTestDrivers() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const testDrivers = [
      {
        name: 'Test Biker 1',
        phone: '+919876543201',
        role: 'driver',
        isDriver: true,
        isOnline: true,
        vehicleType: 'bike',
        isBusy: false,
        location: {
          type: 'Point',
          coordinates: [17.3858, 17.3858],
        },
        vehicleBrand: 'Honda',
        vehicleNumber: 'TS09AA1111',
        rating: 4.8,
      },
     
      {
        name: 'Test Auto 1',
        phone: '+919876543203',
        role: 'driver',
        isDriver: true,
        isOnline: false,
        vehicleType: 'auto',
        isBusy: false,
        location: {
          type: 'Point',
          coordinates: [78.485671, 17.384044],
        },
        vehicleBrand: 'Bajaj',
        vehicleNumber: 'TS09CC3333',
        rating: 4.7,
      },
    ];

    console.log(`\n📝 Creating ${testDrivers.length} test drivers...`);

    for (const driverData of testDrivers) {
      await User.findOneAndUpdate(
        { phone: driverData.phone },
        driverData,
        { upsert: true, new: true }
      );
      console.log(`✅ Created/Updated: ${driverData.name}`);
    }

    console.log('\n✅ Done!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

addTestDrivers();