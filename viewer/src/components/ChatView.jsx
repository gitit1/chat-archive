import { useEffect, useState } from 'react';
import {
  Box, Typography, CircularProgress, FormControlLabel, Switch, Chip, Divider,
} from '@mui/material';
import { api, formatDate } from '../api.js';
import MessageBubble from './MessageBubble.jsx';

export default function ChatView({ conversationId }) {
  const [conv, setConv] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (conversationId == null) {
      setConv(null);
      return;
    }
    setLoading(true);
    api.conversation(conversationId, showHidden)
      .then(setConv)
      .catch((e) => console.error('conversation', e))
      .finally(() => setLoading(false));
  }, [conversationId, showHidden]);

  if (conversationId == null) {
    return (
      <Box sx={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body1" color="text.secondary">
          בחרו שיחה כדי לקרוא אותה
        </Typography>
      </Box>
    );
  }

  if (loading && !conv) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!conv) return null;

  return (
    <Box sx={{ maxWidth: 860, mx: 'auto', p: { xs: 2, md: 3 } }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
          {conv.title}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
          {conv.projectName && <Chip size="small" label={conv.projectName} color="primary" variant="outlined" />}
          {conv.model && <Chip size="small" label={conv.model} variant="outlined" />}
          <Typography variant="caption" color="text.secondary">
            {formatDate(conv.createdAt)}
          </Typography>
        </Box>
        <FormControlLabel
          control={<Switch size="small" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />}
          label={<Typography variant="caption">הצג הודעות מוסתרות (מחשבות המודל)</Typography>}
        />
      </Box>
      <Divider sx={{ mb: 2 }} />

      {conv.messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}

      {conv.messages.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
          אין הודעות גלויות בשיחה זו.
        </Typography>
      )}
    </Box>
  );
}
