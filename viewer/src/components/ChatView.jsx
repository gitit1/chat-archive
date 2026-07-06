import { useEffect, useState } from 'react';
import {
  Box, Typography, CircularProgress, FormControlLabel, Switch, Chip, Divider,
  TextField, IconButton, Menu, MenuItem, Button, Stack,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import AddIcon from '@mui/icons-material/Add';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { api, formatDate } from '../api.js';
import MessageBubble from './MessageBubble.jsx';

function TagEditor({ conv, onChange }) {
  const [tags, setTags] = useState(conv.tags ?? []);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');

  useEffect(() => { setTags(conv.tags ?? []); }, [conv.id, conv.tags]);

  const add = async () => {
    const name = value.trim();
    if (!name) { setAdding(false); return; }
    try {
      const { tag } = await api.addTag(conv.id, name);
      if (!tags.some((t) => t.id === tag.id)) setTags([...tags, tag]);
      onChange?.();
    } catch (e) { console.error('addTag', e); }
    setValue(''); setAdding(false);
  };
  const remove = async (tagId) => {
    try {
      await api.removeTag(conv.id, tagId);
      setTags(tags.filter((t) => t.id !== tagId));
      onChange?.();
    } catch (e) { console.error('removeTag', e); }
  };

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
      <LocalOfferIcon fontSize="small" sx={{ color: 'text.disabled' }} />
      {tags.map((t) => (
        <Chip key={t.id} size="small" label={t.name} onDelete={() => remove(t.id)}
          sx={{ bgcolor: t.color ? `${t.color}22` : undefined, borderColor: t.color, color: t.color }}
          variant="outlined" />
      ))}
      {adding ? (
        <TextField size="small" autoFocus value={value} placeholder="שם תגית"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { setAdding(false); setValue(''); } }}
          onBlur={add} sx={{ width: 130, '& input': { fontSize: 13, py: 0.5 } }} />
      ) : (
        <Chip size="small" variant="outlined" icon={<AddIcon />} label="תגית" onClick={() => setAdding(true)}
          sx={{ borderStyle: 'dashed' }} />
      )}
    </Stack>
  );
}

export default function ChatView({ conversationId, onTagsChanged }) {
  const [conv, setConv] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [exportEl, setExportEl] = useState(null);

  useEffect(() => {
    if (conversationId == null) { setConv(null); return; }
    setLoading(true);
    api.conversation(conversationId, showHidden)
      .then(setConv)
      .catch((e) => console.error('conversation', e))
      .finally(() => setLoading(false));
  }, [conversationId, showHidden]);

  if (conversationId == null) {
    return (
      <Box sx={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body1" color="text.secondary">בחרו שיחה כדי לקרוא אותה</Typography>
      </Box>
    );
  }
  if (loading && !conv) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>;
  }
  if (!conv) return null;

  return (
    <Box sx={{ maxWidth: 860, mx: 'auto', p: { xs: 2, md: 3 } }}>
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5, flex: 1 }}>{conv.title}</Typography>
          <Button size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={(e) => setExportEl(e.currentTarget)}>
            ייצוא
          </Button>
          <Menu anchorEl={exportEl} open={!!exportEl} onClose={() => setExportEl(null)}>
            <MenuItem component="a" href={api.exportUrl(conv.id, 'md')} onClick={() => setExportEl(null)}>
              ייצוא כ‑Markdown
            </MenuItem>
            <MenuItem component="a" href={api.exportUrl(conv.id, 'json')} onClick={() => setExportEl(null)}>
              ייצוא כ‑JSON
            </MenuItem>
          </Menu>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
          {conv.projectName && <Chip size="small" label={conv.projectName} color="primary" variant="outlined" />}
          {conv.model && <Chip size="small" label={conv.model} variant="outlined" />}
          <Typography variant="caption" color="text.secondary">{formatDate(conv.createdAt)}</Typography>
        </Box>
        <Box sx={{ mb: 1 }}>
          <TagEditor conv={conv} onChange={onTagsChanged} />
        </Box>
        <FormControlLabel
          control={<Switch size="small" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />}
          label={<Typography variant="caption">הצג הודעות מוסתרות (מחשבות המודל)</Typography>} />
      </Box>
      <Divider sx={{ mb: 2 }} />

      {conv.messages.map((m) => <MessageBubble key={m.id} message={m} />)}
      {conv.messages.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
          אין הודעות גלויות בשיחה זו.
        </Typography>
      )}
    </Box>
  );
}
