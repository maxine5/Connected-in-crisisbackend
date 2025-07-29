const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: true }));
const cors = require('cors');
app.use(cors());
function logAdminAction(action, details) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${action}: ${details}\n`;
  fs.appendFile('admin.log', entry, (err) => {
    if (err) console.error('Failed to write log:', err);
  });
}
const db = new sqlite3.Database('database.sqlite');

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'connected-in-crisis-secret',
  resave: false,
  saveUninitialized: true
}));

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS evacuees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dob TEXT NOT NULL,
    shelter TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS shelters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS qr_links (
    qr_id TEXT NOT NULL,
    name TEXT NOT NULL,
    dob TEXT NOT NULL
  )`);

});

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Search route
app.get("/lookup", (req, res) => {
  const { name, dob } = req.query;
  db.get('SELECT shelter FROM evacuees WHERE name = ? AND dob = ?', [name, dob], (err, row) => {
    if (err) {
  console.error("DB error in /lookup:", err);
  return res.status(500).send("Error querying database.");
}
    if (row) {
      const result = `Name: ${name}<br>DOB: ${dob}<br>Shelter: ${row.shelter}`;
      res.redirect(`https://maxine5.github.io/Connected-in-crisis/result_template.html?r=${encodeURIComponent(result)}`);
    } else {
      res.redirect(`https://maxine5.github.io/Connected-in-crisis/result_template.html?r=${encodeURIComponent('No matching evacuee found.')}`);
    }
});
  });


// Admin login page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin_login.html'));
});
app.get('/admin-login', (req, res) => {
  res.redirect('/admin'); 
});

// Admin login handling
app.post('/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin') {
    req.session.authenticated = true;logAdminAction('LOGIN', 'Admin logged in');

    res.redirect('/admin-dashboard');
  } else {
    res.status(401).send('Invalid credentials');
  }
});
// User login page
app.get('/user', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/user_login.html'));
});

// User login handling
app.post('/user-login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'user' && password === 'user') {
    req.session.user = true;
    logAdminAction('USER_LOGIN', 'User logged in');
    res.redirect('/user-dashboard');
  } else {
    logAdminAction('FAILED_USER_LOGIN', `Username=${username}`);
    res.send('Invalid credentials');
  }
});


// Admin dashboard
app.get('/admin-dashboard', (req, res) => {
  if (req.session.authenticated) {
    res.sendFile(path.join(__dirname, 'public/admin_dashboard.html'));
  } else {
    res.redirect('/admin');
  }
});
// User dashboard
app.get('/user-dashboard', (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, 'public/user_dashboard.html'));
  } else {
    res.redirect('/user');
  }
});
// Serve user add evacuee page
app.get('/user-add-evacuee', (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, 'public/user_add_evacuee.html'));
  } else {
    res.redirect('/user');
  }
});



// Add new evacuee
app.post('/add-evacuee', (req, res) => {
  if (!req.session.authenticated) return res.status(403).send('Unauthorized');
  const { name, dob, shelter } = req.body;
  db.run('INSERT INTO evacuees (name, dob, shelter) VALUES (?, ?, ?)', [name, dob, shelter], (err) => {
    if (err) return res.status(500).send('Error adding evacuee.');
logAdminAction('ADD_EVACUEE', `Name=${name}, DOB=${dob}, Shelter=${shelter}`);

    res.redirect('/admin-dashboard');
  });
});

// Add new shelter
app.post('/add-shelter', (req, res) => {
  if (!req.session.authenticated) return res.status(403).send('Unauthorized');
  const { name, address } = req.body;
  db.run('INSERT INTO shelters (name, address) VALUES (?, ?)', [name, address], (err) => {
    if (err) return res.status(500).send('Error adding shelter.');
logAdminAction('ADD_SHELTER', `Name=${name}, Address=${address}`);

    res.redirect('/admin-dashboard');
  });
});

// User adds evacuee
app.post('/user-add-evacuee', (req, res) => {
  if (!req.session.user) return res.status(403).send('Unauthorized');

  const { name, dob, shelter } = req.body;
  db.run('INSERT INTO evacuees (name, dob, shelter) VALUES (?, ?, ?)', [name, dob, shelter], (err) => {
    if (err) return res.status(500).send('Error adding evacuee.');
    logAdminAction('USER_ADD_EVACUEE', `Name=${name}, DOB=${dob}, Shelter=${shelter}`);
    res.redirect('/user-dashboard');
  });
});

app.post('/delete-evacuee', (req, res) => {
  if (!req.session.authenticated) return res.status(403).send('Unauthorized');

  const { name, dob, confirmName, confirmDob } = req.body;

  if (name !== confirmName || dob !== confirmDob) {
    return res.status(400).send('Name and DOB confirmation must match.');
  }

  db.run('DELETE FROM evacuees WHERE name = ? AND dob = ?', [name, dob], function (err) {
    if (err) return res.status(500).send('Error deleting evacuee.');

    if (this.changes === 0) {
      return res.status(404).send('No matching evacuee found.');
    }

    logAdminAction('DELETE_EVACUEE', `Name=${name}, DOB=${dob}`);
    res.redirect('/admin-dashboard');
  });
});

// Process QR assignment form
app.post('/assign-qr', (req, res) => {
  const { qr_id, name, dob, shelter } = req.body;

  // First insert evacuee
  db.run('INSERT INTO evacuees (name, dob, shelter) VALUES (?, ?, ?)', [name, dob, shelter], function (err) {
    if (err) return res.status(500).send('Error saving evacuee.');

    // Then link evacuee to QR ID
    db.run('INSERT INTO qr_links (qr_id, name, dob) VALUES (?, ?, ?)', [qr_id, name, dob], function (err) {
      if (err) return res.status(500).send('Error linking QR code.');

      logAdminAction('QR_ASSIGNED', `QR=${qr_id}, Name=${name}, DOB=${dob}, Shelter=${shelter}`);
      res.redirect(`/qr-confirm/${qr_id}`);
    });
  });
});



// Show QR confirmation


app.get('/qr-confirm/:qr_id', (req, res) => {
  const qrId = req.params.qr_id;

  db.get(
    'SELECT evacuees.name, evacuees.dob, evacuees.shelter FROM qr_links JOIN evacuees ON qr_links.name = evacuees.name AND qr_links.dob = evacuees.dob WHERE qr_links.qr_id = ?',
    [qrId],
    (err, row) => {
      if (err) return res.status(500).send('Database error');
      if (!row) return res.status(404).send('No data linked to this QR code');

      // Save evacuee data in a temporary session or variable (for templating)
      req.session.qrData = row;
      res.sendFile(path.join(__dirname, 'public/qr_confirm.html'));
    }
  );
});
app.use((req, res) => {
  res.status(404).send(`Route ${req.originalUrl} not found`);
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
