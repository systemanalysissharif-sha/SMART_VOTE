const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const db = require('./db.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Multer config for candidate image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, 'cand_' + Date.now() + ext);
    }
});
const upload = multer({ 
    storage, 
    limits: { fileSize: 5 * 1024 * 1024 },  // 5MB max
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp/;
        const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
        const mimeOk = allowed.test(file.mimetype);
        cb(null, extOk && mimeOk);
    }
});

// Middleware
app.use(express.static(path.join(__dirname, '/')));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

// API Endpoints
app.get('/api/state', async (req, res) => {
    try {
        const state = await db.getAllData();
        res.json(state);
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/api/position', async (req, res) => {
    try {
        await db.addPosition(req.body.id, req.body.name);
        
        // Automated notification
        const msg = `System Announcement: A new election post has been added for "${req.body.name}".`;
        await db.postNotification('sys_'+Date.now(), msg, new Date().toLocaleTimeString());

        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.delete('/api/position/:id', async (req, res) => {
    try {
        await db.removePosition(req.params.id);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

// Candidate registration with optional image upload
app.post('/api/candidate', upload.single('image'), async (req, res) => {
    try {
        const { id, name, bio, positionId } = req.body;
        const image = req.file ? '/uploads/' + req.file.filename : null;
        await db.addCandidate(id, name, bio, positionId, image);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.delete('/api/candidate/:id', async (req, res) => {
    try {
        await db.deleteCandidate(req.params.id);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.post('/api/candidate/approve/:id', async (req, res) => {
    try {
        await db.approveCandidate(req.params.id);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.post('/api/candidate/blacklist/:id', async (req, res) => {
    try {
        await db.blacklistCandidate(req.params.id);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.post('/api/notification', async (req, res) => {
    try {
        const { id, message, time } = req.body;
        await db.postNotification(id, message, time);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

// --- Admin Auth Endpoints ---

// Check if admin account exists
app.get('/api/admin/status', async (req, res) => {
    try {
        const admin = await db.getAdmin();
        res.json({ exists: !!admin });
    } catch (err) {
        res.status(500).send('Error');
    }
});

// First-time admin setup (only works once)
app.post('/api/admin/setup', async (req, res) => {
    try {
        const { username, password } = req.body;
        await db.createAdmin(username, password);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const admin = await db.loginAdmin(username, password);
        if (admin) {
            res.status(200).json({ success: true, admin });
        } else {
            res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
    } catch (err) {
        res.status(500).send('Error logging in');
    }
});

// Admin change credentials
app.post('/api/admin/update-credentials', async (req, res) => {
    try {
        const { currentPassword, newUsername, newPassword } = req.body;
        await db.updateAdminCredentials(currentPassword, newUsername, newPassword);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// --- Voter Auth Endpoints ---

// Admin: Add an eligible voter ID
app.post('/api/admin/eligible-voter', async (req, res) => {
    try {
        const { id, email } = req.body;
        await db.addEligibleVoterId(id, email);
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(400).send('Error adding ID or Email. It might already exist.');
    }
});

// Voter: Verify ID before registration
app.post('/api/auth/verify', async (req, res) => {
    try {
        const result = await db.verifyVoterId(req.body.id);
        res.json(result);
    } catch (err) {
        res.status(500).send('Error');
    }
});

// Voter: Formally register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { voterId, name, email, password } = req.body;
        const uuid = crypto.randomUUID();
        
        await db.registerVoter(uuid, voterId, name, email, password);
        broadcastState();
        res.status(200).json({ success: true, uuid });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message || 'Registration failed.'});
    }
});

// Voter: Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await db.loginVoter(email, password);
        
        if (user) {
            res.status(200).json({ success: true, user });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).send('Error logging in');
    }
});

// Voter: Change password
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { voterId, currentPassword, newPassword } = req.body;
        await db.updateVoterPassword(voterId, currentPassword, newPassword);
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message || 'Failed to change password' });
    }
});

// Voter: Cast a vote
app.post('/api/vote', async (req, res) => {
    try {
        const { voterId, candidateId, positionId } = req.body;
        
        // Time window check
        const data = await db.getAllData();
        const settings = data.settings || {};
        const now = Date.now();
        const start = settings.start_time ? new Date(settings.start_time).getTime() : 0;
        const end = settings.end_time ? new Date(settings.end_time).getTime() : 0;
        
        if (start && now < start) return res.status(400).json({ success: false, message: 'Election has not started yet.' });
        if (end && now > end) return res.status(400).json({ success: false, message: 'Election has ended.' });

        const success = await db.castVote(voterId, candidateId, positionId);
        
        if (success) {
            broadcastState();
            res.status(200).json({ success: true });
        } else {
            res.status(400).json({ success: false, message: 'Already voted for this position' });
        }
    } catch (err) {
        res.status(500).send('Error');
    }
});

// Socket.io for Real-Time Sync
io.on('connection', (socket) => {
    console.log('User connected');
    
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

async function broadcastState() {
    try {
        const state = await db.getAllData();
        io.emit('sync', state);
    } catch(err) {
        console.error('Error broadcasting state:', err);
    }
}

// Admin: Update Election Settings
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { start_time, end_time } = req.body;
        await db.updateSettings(start_time, end_time);
        
        // Automated notification
        let msg = `System Announcement: The Voting Schedule has been officially updated. `;
        if (start_time && end_time) msg += `Voting will begin precisely at ${new Date(start_time).toLocaleString()} and conclude at ${new Date(end_time).toLocaleString()}.`;
        else if (start_time) msg += `Voting will officially kick off at ${new Date(start_time).toLocaleString()}.`;
        else if (end_time) msg += `The ongoing voting period will conclude at ${new Date(end_time).toLocaleString()}.`;
        else msg += `The election window is now set to Open indefinitely.`;
        
        await db.postNotification('sys_'+Date.now(), msg, new Date().toLocaleTimeString());
        
        broadcastState();
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error updating configuration');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SmartVote Server running on port ${PORT}`);
});
