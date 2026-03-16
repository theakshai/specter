/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'nordic-grey': '#1e1e1e',
        'mercury-white': '#e5e5e5',
        'brand-orange': '#ff8a00',
      },
      fontFamily: {
        'datatype': ['Datatype', 'monospace'],
      },
    },
  },
  plugins: [],
}
