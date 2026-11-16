// Warm light "iOS" palette. The zinc scale is inverted (950 = page background, 100 = ink) and
// `white` is the ink colour, so the app's original dark-theme classes render as a light theme.
module.exports = {
  content: ['./index.html', './collect.html', './overview.html'],
  theme: {
    extend: {
      fontFamily: { sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'] },
      colors: {
        white: '#2A1E1B',
        zinc: { 50: '#1E1513', 100: '#2A1E1B', 200: '#3B2F2C', 300: '#5C4E4A', 400: '#86776F', 500: '#A39591', 600: '#D3C4BF', 700: '#EBDDD8', 800: '#F6ECE8', 900: '#FFFFFF', 950: '#FFF6F2' },
        blue: { 300: '#FFB3C6', 400: '#F77FA0', 500: '#F2547D', 600: '#EE4D77', 700: '#D93A64' },
        emerald: { 300: '#3CC089', 400: '#16A36A', 500: '#1F9D63', 600: '#17915A', 700: '#12784A' },
        amber: { 400: '#C77A12' },
        sky: { 400: '#0284C7' }
      }
    }
  }
};
