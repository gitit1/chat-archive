import { createTheme } from '@mui/material/styles';

// RTL + Hebrew-first theme. Heebo reads well for Hebrew UI; system fallback for Latin.
export const theme = createTheme({
  direction: 'rtl',
  palette: {
    mode: 'light',
    primary: { main: '#3f6ad8' },
    background: { default: '#f4f5f7', paper: '#ffffff' },
  },
  typography: {
    fontFamily: '"Heebo", "Segoe UI", system-ui, -apple-system, sans-serif',
    fontSize: 14,
  },
  shape: { borderRadius: 8 },
  components: {
    MuiListItemButton: {
      styleOverrides: { root: { borderRadius: 8, marginInline: 4 } },
    },
  },
});
