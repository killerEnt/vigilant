// Public, no secrets: tells the web app whether the cloud database is configured.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, db: !!process.env.MONGODB_URI });
};
