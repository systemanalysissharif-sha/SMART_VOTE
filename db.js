const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Initialize database schema
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS positions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS candidates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            bio TEXT,
            positionId TEXT,
            status TEXT DEFAULT 'Approved',
            image TEXT
        )
    `, () => {
        // Migration: add image column if missing from older schema
        db.run("ALTER TABLE candidates ADD COLUMN image TEXT", () => {});
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            time TEXT NOT NULL
        )
    `);

    // Authentication Tables
    db.run(`
        CREATE TABLE IF NOT EXISTS eligible_voters (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            is_registered INTEGER DEFAULT 0
        )
    `, () => {
        db.run("ALTER TABLE eligible_voters ADD COLUMN email TEXT UNIQUE", () => {});
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS voters (
            uuid TEXT PRIMARY KEY,
            voter_id TEXT NOT NULL,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            FOREIGN KEY(voter_id) REFERENCES eligible_voters(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            voterId TEXT NOT NULL,
            candidateId TEXT NOT NULL,
            positionId TEXT NOT NULL,
            FOREIGN KEY(voterId) REFERENCES voters(uuid)
        )
    `);

    // Global Settings Table for Election Time Window
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `, () => {
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('start_time', '')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('end_time', '')");
    });

    // Admin Users Table (first-user lockdown)
    db.run(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    `);

    // Add initial data if empty
    db.get('SELECT COUNT(*) as count FROM positions', (err, row) => {
        if (!err && row.count === 0) {
            db.run("INSERT INTO positions (id, name) VALUES ('p1', 'President')");
        }
    });
});

module.exports = {
    getAllData: () => {
        return new Promise((resolve, reject) => {
            const data = {
                positions: [],
                candidates: [],
                votes: [],
                notifications: [],
                eligible_voters: []
            };
            
            db.all("SELECT * FROM positions", (err, positions) => {
                if (err) return reject(err);
                data.positions = positions;
                
                db.all("SELECT * FROM candidates", (err, candidates) => {
                    if (err) return reject(err);
                    data.candidates = candidates;

                    db.all("SELECT * FROM votes", (err, votes) => {
                        if (err) return reject(err);
                        data.votes = votes;

                        db.all("SELECT * FROM notifications", (err, notifications) => {
                            if (err) return reject(err);
                            data.notifications = notifications;
                            
                            db.all("SELECT id, email, is_registered FROM eligible_voters", (err, eVoters) => {
                                if (err) return reject(err);
                                data.eligible_voters = eVoters;
                                
                                db.all("SELECT key, value FROM settings", (err, settingsRows) => {
                                    if (err) return reject(err);
                                    const settingsObj = {};
                                    if (settingsRows) {
                                        settingsRows.forEach(r => settingsObj[r.key] = r.value);
                                    }
                                    data.settings = settingsObj;
                                    resolve(data);
                                });
                            });
                        });
                    });
                });
            });
        });
    },

    // Standard APIs
    addPosition: (id, name) => {
        return new Promise((resolve, reject) => {
            db.run("INSERT INTO positions (id, name) VALUES (?, ?)", [id, name], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    removePosition: (id) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM positions WHERE id = ?", [id], err => {
                if (err) return reject(err);
                db.run("DELETE FROM candidates WHERE positionId = ?", [id], err => {
                    if (err) return reject(err);
                    db.run("DELETE FROM votes WHERE positionId = ?", [id], err => {
                        if (err) return reject(err);
                        resolve();
                    });
                });
            });
        });
    },

    addCandidate: (id, name, bio, positionId, image) => {
        return new Promise((resolve, reject) => {
            db.run("INSERT INTO candidates (id, name, bio, positionId, status, image) VALUES (?, ?, ?, ?, 'Approved', ?)", 
                [id, name, bio, positionId, image || null], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    deleteCandidate: (id) => {
        return new Promise((resolve, reject) => {
            db.run("DELETE FROM candidates WHERE id = ?", [id], err => {
                if (err) return reject(err);
                db.run("DELETE FROM votes WHERE candidateId = ?", [id], err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    },

    approveCandidate: (id) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE candidates SET status = 'Approved' WHERE id = ?", [id], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    postNotification: (id, message, time) => {
        return new Promise((resolve, reject) => {
            db.run("INSERT INTO notifications (id, message, time) VALUES (?, ?, ?)", [id, message, time], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    // Auth & Voters
    addEligibleVoterId: (id, email) => {
        return new Promise((resolve, reject) => {
            db.run("INSERT INTO eligible_voters (id, email) VALUES (?, ?)", [id, email], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    verifyVoterId: (id) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT is_registered FROM eligible_voters WHERE id = ?", [id], (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve({ status: 'invalid' });
                if (row.is_registered) return resolve({ status: 'registered' });
                resolve({ status: 'eligible' });
            });
        });
    },

    registerVoter: (uuid, voterId, name, email, password) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT email FROM eligible_voters WHERE id = ?", [voterId], (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error("ID not found"));
                if (row.email && row.email !== email) return reject(new Error("Provided email does not match the whitelisted email for this ID"));
                
                const hash = hashPassword(password);
                db.run("INSERT INTO voters (uuid, voter_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)", 
                    [uuid, voterId, name, email, hash], err => {
                    
                    if (err) return reject(err);
                    
                    db.run("UPDATE eligible_voters SET is_registered = 1 WHERE id = ?", [voterId], err => {
                        if (err) return reject(err);
                        resolve();
                    });
                });
            });
        });
    },

    blacklistCandidate: (id) => {
        return new Promise((resolve, reject) => {
            db.run("UPDATE candidates SET status = 'Blacklisted' WHERE id = ?", [id], err => {
                if (err) return reject(err);
                resolve();
            });
        });
    },

    updateSettings: (start_time, end_time) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("UPDATE settings SET value = ? WHERE key = 'start_time'", [start_time || '']);
                db.run("UPDATE settings SET value = ? WHERE key = 'end_time'", [end_time || ''], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    },

    loginVoter: (email, password) => {
        return new Promise((resolve, reject) => {
            const hash = hashPassword(password);
            db.get("SELECT uuid, voter_id, name, email FROM voters WHERE email = ? AND password_hash = ?", 
                [email, hash], (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve(null);
                resolve(row);
            });
        });
    },

    castVote: (voterId, candidateId, positionId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT id FROM votes WHERE voterId = ? AND positionId = ?", [voterId, positionId], (err, row) => {
                if (err) return reject(err);
                if (row) return resolve(false); // Already voted

                db.run("INSERT INTO votes (voterId, candidateId, positionId) VALUES (?, ?, ?)", 
                    [voterId, candidateId, positionId], err => {
                    if (err) return reject(err);
                    resolve(true);
                });
            });
        });
    },

    updateVoterPassword: (voterId, currentPassword, newPassword) => {
        return new Promise((resolve, reject) => {
            const currentHash = hashPassword(currentPassword);
            db.get("SELECT uuid FROM voters WHERE uuid = ? AND password_hash = ?", [voterId, currentHash], (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error("Current password is incorrect"));

                const newHash = hashPassword(newPassword);
                db.run("UPDATE voters SET password_hash = ? WHERE uuid = ?", [newHash, row.uuid], err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    },

    // ---- Admin Auth ----
    getAdmin: () => {
        return new Promise((resolve, reject) => {
            db.get("SELECT id, username FROM admin_users LIMIT 1", (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
    },

    createAdmin: (username, password) => {
        return new Promise((resolve, reject) => {
            // Only allow if no admin exists yet
            db.get("SELECT COUNT(*) as count FROM admin_users", (err, row) => {
                if (err) return reject(err);
                if (row.count > 0) return reject(new Error("Admin already exists. Setup is locked."));

                const hash = hashPassword(password);
                db.run("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", [username, hash], err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    },

    loginAdmin: (username, password) => {
        return new Promise((resolve, reject) => {
            const hash = hashPassword(password);
            db.get("SELECT id, username FROM admin_users WHERE username = ? AND password_hash = ?",
                [username, hash], (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
    },

    updateAdminCredentials: (currentPassword, newUsername, newPassword) => {
        return new Promise((resolve, reject) => {
            const currentHash = hashPassword(currentPassword);
            db.get("SELECT id FROM admin_users WHERE password_hash = ?", [currentHash], (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error("Current password is incorrect"));

                const newHash = hashPassword(newPassword);
                db.run("UPDATE admin_users SET username = ?, password_hash = ? WHERE id = ?",
                    [newUsername, newHash, row.id], err => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    }
};
