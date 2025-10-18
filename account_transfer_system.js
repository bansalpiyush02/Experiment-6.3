/*
Account Transfer System with Balance Validation (Node.js + Express + MongoDB)
Single-file example for learning and testing (no DB transactions used)

Features:
- Create sample users (/seed)
- Transfer endpoint: POST /transfer
  * validates sender & receiver existence
  * atomically decrements sender using filter balance >= amount
  * increments receiver
  * performs rollback (refund) if receiver update fails
- Helpful error messages and example curl commands

Run:
1. Install dependencies: npm install express mongoose body-parser
2. Start MongoDB (local or provide MONGODB_URI env var)
3. Run: node Account-Transfer-System.js

This file is intentionally self-contained for teaching. In production, split into modules,
add authentication, logging, rate-limiting, input sanitization, tests and prefer DB
transactions if available.
*/

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/account_transfer_demo';

// Connect to MongoDB
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB:', MONGODB_URI))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// User schema
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  balance: { type: Number, required: true, min: 0 }
});

const User = mongoose.model('User', userSchema);

// Utility: create sample users
app.post('/seed', async (req, res) => {
  try {
    // delete existing and create two users
    await User.deleteMany({});
    const alice = await User.create({ name: 'Alice', balance: 1000 });
    const bob = await User.create({ name: 'Bob', balance: 200 });
    const charlie = await User.create({ name: 'Charlie', balance: 50 });
    return res.json({ message: 'Seed created', users: [alice, bob, charlie] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to seed users' });
  }
});

/*
Transfer logic (no DB transactions):
1. Validate inputs
2. Atomically decrement sender only if balance >= amount using a conditional filter
   (findOneAndUpdate with balance: {$gte: amount}) — this prevents overdraft in race conditions for the decrement step
3. If decrement succeeded, try to increment receiver
4. If increment fails (receiver missing or DB error), refund sender by $inc +amount
5. Return clear messages for all failure modes
*/

app.post('/transfer', async (req, res) => {
  const { fromId, toId, amount } = req.body;

  // Basic validation
  if (!fromId || !toId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid fields. Required: fromId, toId, amount (number).' });
  }
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (fromId === toId) return res.status(400).json({ error: 'Sender and receiver must be different' });

  try {
    // 1) Atomically decrement sender if they have enough balance
    const sender = await User.findOneAndUpdate(
      { _id: fromId, balance: { $gte: amount } }, // filter ensures enough balance
      { $inc: { balance: -amount } },
      { new: true }
    );

    if (!sender) {
      // Could be sender doesn't exist or insufficient funds. Check which.
      const exists = await User.exists({ _id: fromId });
      if (!exists) return res.status(404).json({ error: "Sender account doesn't exist" });
      return res.status(400).json({ error: 'Insufficient funds in sender account' });
    }

    // 2) Increment receiver
    const receiver = await User.findByIdAndUpdate(
      toId,
      { $inc: { balance: amount } },
      { new: true }
    );

    if (!receiver) {
      // Receiver missing — rollback sender by refunding amount
      const refund = await User.findByIdAndUpdate(fromId, { $inc: { balance: amount } }, { new: true });
      // The refund should normally succeed; handle if it doesn't
      if (!refund) {
        // This is a critical state: sender disappeared after decrement — very unlikely but handle
        console.error('CRITICAL: sender missing during rollback. Manual intervention required. fromId=', fromId);
        return res.status(500).json({ error: 'Receiver not found and refund failed. Manual DB repair required.' });
      }
      return res.status(404).json({ error: "Receiver account doesn't exist. Sender refunded." });
    }

    // Success
    return res.json({ message: 'Transfer successful', sender, receiver });

  } catch (err) {
    console.error('Transfer error:', err);
    // Attempt best-effort rollback if sender was partly updated
    // (We cannot always know; in this simple example we avoid complicated analysis and return 500.)
    return res.status(500).json({ error: 'Internal server error during transfer' });
  }
});

// Small helper endpoint to list users
app.get('/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-__v');
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user
app.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-__v');
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

/*
Example curl commands to test the system

1) Start server and seed users:
   curl -X POST http://localhost:3000/seed
   -> response includes the created users with _id values. Copy them.

2) List users:
   curl http://localhost:3000/users

3) Successful transfer (assume aliceId and bobId from seed):
   curl -X POST http://localhost:3000/transfer \
     -H 'Content-Type: application/json' \
     -d '{"fromId":"<aliceId>","toId":"<bobId>","amount":150}'

   Expected: Transfer successful, sender.balance reduced by 150, receiver.balance increased.

4) Failed transfer due to insufficient funds:
   curl -X POST http://localhost:3000/transfer \
     -H 'Content-Type: application/json' \
     -d '{"fromId":"<charlieId>","toId":"<bobId>","amount":1000}'

   Expected: 400 with message 'Insufficient funds in sender account'

5) Failed transfer due to receiver not existing (rolls back):
   curl -X POST http://localhost:3000/transfer \
     -H 'Content-Type: application/json' \
     -d '{"fromId":"<aliceId>","toId":"000000000000000000000000","amount":50}'

   Expected: 404 'Receiver account doesn't exist. Sender refunded.' and balances unchanged.

Discussion & notes:
- The key atomic step is decrementing the sender with a filter balance >= amount. That prevents overdrafts even under concurrent requests targeting the same sender.
- We still do a non-atomic receiver increment which could fail; we handle that by refunding the sender.
- This pattern is reasonably safe for small demos. For production, prefer database transactions (MongoDB session transactions, or RDBMS transactions) to ensure full atomicity across documents.
- Also add logging, retries (with idempotency token), and stronger validation.
*/
