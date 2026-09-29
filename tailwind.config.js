/** @type {import('tailwindcss').Config} */
module.exports = {
  // Class names live in the static shell and in the server-rendered fragments.
  content: ['./public/index.html', './src/views.js'],
  theme: { extend: {} },
  plugins: [require('daisyui')],
  // Dark is listed first, so it is what daisyUI applies when no data-theme
  // attribute is set.
  daisyui: { themes: ['dark', 'light'], logs: false },
};
