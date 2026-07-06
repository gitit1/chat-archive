import { useState } from 'react';
import {
  Box, List, ListItemButton, ListItemText, Typography, TextField,
  InputAdornment, Chip, Divider, CircularProgress,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import FolderIcon from '@mui/icons-material/Folder';
import InboxIcon from '@mui/icons-material/AllInbox';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';

// Right-hand (inline-start in RTL) column: search box + the project list.
export default function ProjectSidebar({ data, selected, onSelect, onSearch, searching, searchQuery }) {
  const [term, setTerm] = useState('');

  const submit = (e) => {
    e.preventDefault();
    onSearch(term);
  };

  const row = (sel, icon, label, count, active) => (
    <ListItemButton key={sel.id} selected={active} onClick={() => onSelect(sel)}>
      {icon}
      <ListItemText
        primary={label}
        primaryTypographyProps={{ noWrap: true, fontWeight: active ? 700 : 400 }}
        sx={{ mx: 1 }}
      />
      <Chip label={count.toLocaleString('he-IL')} size="small" variant="outlined" />
    </ListItemButton>
  );

  return (
    <Box sx={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', bgcolor: 'background.paper' }}>
      <Box component="form" onSubmit={submit} sx={{ p: 1.5 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="חיפוש בכל השיחות…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                {searching ? <CircularProgress size={18} /> : <SearchIcon fontSize="small" />}
              </InputAdornment>
            ),
          }}
        />
        {searchQuery && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
            תוצאות עבור "{searchQuery}" — נקה את החיפוש כדי לחזור לפרויקטים
          </Typography>
        )}
      </Box>
      <Divider />

      <List dense sx={{ overflowY: 'auto', flex: 1 }}>
        {!data ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            {row(
              { type: 'all', id: 'all', name: 'כל השיחות' },
              <InboxIcon fontSize="small" color="action" />,
              'כל השיחות', data.total, selected.id === 'all'
            )}
            <Divider sx={{ my: 0.5 }} />
            {data.projects.map((p) =>
              row(
                { type: 'project', id: p.id, name: p.name },
                <FolderIcon fontSize="small" sx={{ color: 'primary.main' }} />,
                p.name, p.count, selected.id === p.id
              )
            )}
            <Divider sx={{ my: 0.5 }} />
            {row(
              { type: 'none', id: 'none', name: 'ללא פרויקט' },
              <HelpOutlineIcon fontSize="small" color="action" />,
              'ללא פרויקט', data.noProjectCount, selected.id === 'none'
            )}
          </>
        )}
      </List>
    </Box>
  );
}
