import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, IconButton, Box, Typography, Grid,
  Paper, CircularProgress, Divider, Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '../api.js';

const BAR = '#3f6ad8';

function StatTile({ label, value }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, textAlign: 'center', height: '100%' }}>
      <Typography variant="h5" sx={{ fontWeight: 700, color: 'primary.main' }}>
        {value.toLocaleString('he-IL')}
      </Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Paper>
  );
}

// Horizontal bars, sorted by the caller, one hue for magnitude.
function BarList({ items, labelKey, valueKey }) {
  const max = Math.max(1, ...items.map((i) => i[valueKey]));
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {items.map((it, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" sx={{ width: 150, flexShrink: 0, textAlign: 'start' }} noWrap
            title={it[labelKey]}>
            {it[labelKey]}
          </Typography>
          <Box sx={{ flex: 1, bgcolor: 'action.hover', borderRadius: 0.5, overflow: 'hidden' }}>
            <Box sx={{ width: `${(it[valueKey] / max) * 100}%`, minWidth: 2, height: 16, bgcolor: BAR }} />
          </Box>
          <Typography variant="caption" sx={{ width: 44, flexShrink: 0, textAlign: 'start' }}>
            {it[valueKey].toLocaleString('he-IL')}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

// Monthly columns — time reads right→left in RTL, so newest is on the left.
function Timeline({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: 120, direction: 'ltr' }}>
      {data.map((d) => (
        <Tooltip key={d.month} title={`${d.month}: ${d.count}`} arrow>
          <Box sx={{ flex: 1, minWidth: 3, height: `${(d.count / max) * 100}%`, bgcolor: BAR,
                     borderRadius: '2px 2px 0 0', '&:hover': { bgcolor: 'primary.dark' } }} />
        </Tooltip>
      ))}
    </Box>
  );
}

export default function StatsDialog({ open, onClose }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (open && !stats) api.stats().then(setStats).catch((e) => console.error('stats', e));
  }, [open, stats]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center' }}>
        סטטיסטיקות הארכיון
        <Box sx={{ flex: 1 }} />
        <IconButton onClick={onClose} size="small"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {!stats ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Grid container spacing={1.5}>
              <Grid item xs={6} sm={3}><StatTile label="שיחות" value={stats.totalConversations} /></Grid>
              <Grid item xs={6} sm={3}><StatTile label="הודעות" value={stats.totalMessages} /></Grid>
              <Grid item xs={6} sm={3}><StatTile label="הודעות גלויות" value={stats.visibleMessages} /></Grid>
              <Grid item xs={6} sm={3}><StatTile label="קבצים תואמים" value={stats.attachments.matched ?? 0} /></Grid>
            </Grid>

            <Box>
              <Typography variant="subtitle2" gutterBottom>שיחות לפי חודש</Typography>
              <Timeline data={stats.byMonth} />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', direction: 'ltr', mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">{stats.byMonth[0]?.month}</Typography>
                <Typography variant="caption" color="text.secondary">{stats.byMonth[stats.byMonth.length - 1]?.month}</Typography>
              </Box>
            </Box>
            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>שיחות לפי פרויקט</Typography>
              <BarList items={[...stats.projects, { name: 'ללא פרויקט', count: stats.noProject }]}
                labelKey="name" valueKey="count" />
            </Box>
            <Divider />

            <Box>
              <Typography variant="subtitle2" gutterBottom>שיחות לפי מודל</Typography>
              <BarList items={stats.byModel} labelKey="model" valueKey="count" />
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
