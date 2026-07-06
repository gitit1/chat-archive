import { useState } from 'react';
import {
  Box, List, ListItemButton, ListItemText, Typography, TextField,
  InputAdornment, Chip, Divider, CircularProgress,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import FolderIcon from '@mui/icons-material/Folder';
import InboxIcon from '@mui/icons-material/AllInbox';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';

// Right-hand (inline-start in RTL) column: search box + project & tag navigation.
export default function ProjectSidebar({ data, tags, selected, onSelect, onSearch, searching, searchQuery }) {
  const [term, setTerm] = useState('');
  const submit = (e) => { e.preventDefault(); onSearch(term); };

  const isActive = (type, id) => selected.type === type && selected.id === id;

  const row = (sel, icon, label, count, active, dot) => (
    <ListItemButton key={`${sel.type}:${sel.id}`} selected={active} onClick={() => onSelect(sel)}>
      {dot ? <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: dot, flexShrink: 0 }} /> : icon}
      <ListItemText primary={label}
        primaryTypographyProps={{ noWrap: true, fontWeight: active ? 700 : 400 }} sx={{ mx: 1 }} />
      {count != null && <Chip label={count.toLocaleString('he-IL')} size="small" variant="outlined" />}
    </ListItemButton>
  );

  return (
    <Box sx={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', bgcolor: 'background.paper' }}>
      <Box component="form" onSubmit={submit} sx={{ p: 1.5 }}>
        <TextField size="small" fullWidth placeholder="חיפוש בכל השיחות…" value={term}
          onChange={(e) => setTerm(e.target.value)}
          InputProps={{ startAdornment: (
            <InputAdornment position="start">
              {searching ? <CircularProgress size={18} /> : <SearchIcon fontSize="small" />}
            </InputAdornment>
          ) }} />
        {searchQuery && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
            תוצאות עבור "{searchQuery}" — בחרו פרויקט כדי לחזור
          </Typography>
        )}
      </Box>
      <Divider />

      <List dense sx={{ overflowY: 'auto', flex: 1 }}>
        {!data ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
        ) : (
          <>
            {row({ type: 'all', id: 'all', name: 'כל השיחות' },
              <InboxIcon fontSize="small" color="action" />, 'כל השיחות', data.total, isActive('all', 'all'))}
            <Divider sx={{ my: 0.5 }} />
            <Typography variant="overline" sx={{ px: 2, color: 'text.disabled' }}>פרויקטים</Typography>
            {data.projects.map((p) =>
              row({ type: 'project', id: p.id, name: p.name },
                <FolderIcon fontSize="small" sx={{ color: 'primary.main' }} />, p.name, p.count,
                isActive('project', p.id)))}
            {row({ type: 'none', id: 'none', name: 'ללא פרויקט' },
              <HelpOutlineIcon fontSize="small" color="action" />, 'ללא פרויקט', data.noProjectCount,
              isActive('none', 'none'))}

            {tags && tags.length > 0 && (
              <>
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="overline" sx={{ px: 2, color: 'text.disabled' }}>תגיות</Typography>
                {tags.map((t) =>
                  row({ type: 'tag', id: t.id, name: t.name },
                    <LocalOfferIcon fontSize="small" />, t.name, t.count, isActive('tag', t.id), t.color))}
              </>
            )}
          </>
        )}
      </List>
    </Box>
  );
}
