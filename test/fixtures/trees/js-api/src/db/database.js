const sqlite3 = require('sqlite3');

let dbInstance = null;
function getDatabase() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(':memory:');
  }
  return dbInstance;
}

module.exports = { getDatabase };
