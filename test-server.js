const express = require('express');
const app = express();
const PORT = 3010;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', test: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server running on http://0.0.0.0:${PORT}`);
});
