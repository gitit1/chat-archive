import {
  Box, List, ListItemButton, ListItemText, Typography, Divider,
  Select, MenuItem, ToggleButton, Tooltip,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { formatDateShort } from '../api.js';

const SORTS = [
  { value: 'recent', label: 'עודכן לאחרונה' },
  { value: 'oldest', label: 'הישן ביותר' },
  { value: 'messages', label: 'הכי הרבה הודעות' },
  { value: 'title', label: 'לפי כותרת' },
];

function FilterBar({ filters, onFilters, models }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, px: 1.5, py: 1, alignItems: 'center', flexWrap: 'wrap' }}>
      <Select size="small" value={filters.sort} onChange={(e) => onFilters({ ...filters, sort: e.target.value })}
        sx={{ fontSize: 13, minWidth: 130 }}>
        {SORTS.map((s) => <MenuItem key={s.value} value={s.value} sx={{ fontSize: 13 }}>{s.label}</MenuItem>)}
      </Select>
      <Select size="small" displayEmpty value={filters.model}
        onChange={(e) => onFilters({ ...filters, model: e.target.value })}
        sx={{ fontSize: 13, minWidth: 110, maxWidth: 150 }}>
        <MenuItem value="" sx={{ fontSize: 13 }}>כל המודלים</MenuItem>
        {models.map((m) => <MenuItem key={m.model} value={m.model} sx={{ fontSize: 13 }}>{m.model} ({m.count})</MenuItem>)}
      </Select>
      <Tooltip title="מסומנות בכוכב בלבד">
        <ToggleButton value="starred" size="small" selected={filters.starred}
          onChange={() => onFilters({ ...filters, starred: !filters.starred })} sx={{ p: 0.5 }}>
          {filters.starred ? <StarIcon fontSize="small" color="warning" /> : <StarBorderIcon fontSize="small" />}
        </ToggleButton>
      </Tooltip>
    </Box>
  );
}

export default function ConversationList({
  conversations, searchResults, searchQuery, activeConvId, onOpen, headerLabel, filters, onFilters, models,
}) {
  const isSearch = searchResults != null;
  const items = isSearch ? searchResults : conversations;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <Box sx={{ bgcolor: 'background.paper', flexShrink: 0 }}>
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {isSearch ? `תוצאות חיפוש · ${items.length}` : headerLabel}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {items.length.toLocaleString('he-IL')} שיחות
          </Typography>
        </Box>
        {!isSearch && <FilterBar filters={filters} onFilters={onFilters} models={models} />}
        <Divider />
      </Box>

      <Box sx={{ overflowY: 'auto', flex: 1 }}>
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>
            {isSearch ? 'לא נמצאו תוצאות' : 'אין שיחות שמתאימות לסינון'}
          </Typography>
        ) : (
          <List dense disablePadding>
            {items.map((c) => {
              const id = isSearch ? c.conversationId : c.id;
              return (
                <ListItemButton key={isSearch ? `${id}-${c.snippet?.slice(0, 8)}` : id}
                  selected={activeConvId === id} onClick={() => onOpen(id)}
                  sx={{ alignItems: 'flex-start', py: 1 }}>
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        {!isSearch && c.isStarred && <StarIcon sx={{ fontSize: 15, color: 'warning.main' }} />}
                        <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{c.title}</Typography>
                      </Box>
                    }
                    secondary={
                      <>
                        {isSearch ? (
                          <Typography variant="caption" color="text.secondary"
                            sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {c.snippet}
                          </Typography>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {c.messageCount.toLocaleString('he-IL')} הודעות{c.model ? ` · ${c.model}` : ''}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                          {formatDateShort(c.updatedAt)}
                        </Typography>
                      </>
                    }
                    secondaryTypographyProps={{ component: 'span' }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}
      </Box>
    </Box>
  );
}
