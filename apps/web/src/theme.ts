import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    primary: { main: "#125E72", dark: "#0A3D4A", contrastText: "#ffffff" },
    secondary: { main: "#A44A3F" },
    background: { default: "#F4F7F7", paper: "#FFFFFF" },
    text: { primary: "#17242A", secondary: "#4E626B" },
  },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontSize: "clamp(2rem, 5vw, 3.5rem)", fontWeight: 800, lineHeight: 1.08 },
    h2: { fontSize: "clamp(1.55rem, 3vw, 2.1rem)", fontWeight: 750 },
    h3: { fontSize: "1.2rem", fontWeight: 750 },
    button: { textTransform: "none", fontWeight: 700 },
  },
  shape: { borderRadius: 14 },
  components: {
    MuiButton: { styleOverrides: { root: { minHeight: 46, paddingInline: 22 } } },
  },
});
