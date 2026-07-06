import {
  Box, List, ListItemButton, ListItemText, Typography, Divider,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import { formatDateShort } from '../api.js';

// Middle column: either the conversation list for the selected project, or search results.
export default function ConversationList({
  conversations, searchResults, searchQuery, activeConvId, onOpen, headerLabel,
}) {
  const isSearch = searchResults != null;
  const items = isSearch ? searchResults : conversations;

  return (
    <Box>
      <Box sx={{ px: 2, py: 1.5, position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}>
        <Typography variant="subtitle2" noWrap>
          {isSearch ? `תוצאות חיפוש · ${items.length}` : headerLabel}
        </Typography>
        {!isSearch && (
          <Typography variant="caption" color="text.secondary">
            {items.length.toLocaleString('he-IL')} שיחות
          </Typography>
        )}
      </Box>
      <Divider />

      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>
          {isSearch ? 'לא נמצאו תוצאות' : 'אין שיחות'}
        </Typography>
      ) : (
        <List dense disablePadding>
          {items.map((c) => {
            const id = isSearch ? c.conversationId : c.id;
            return (
              <ListItemButton
                key={isSearch ? `${id}-${c.snippet?.slice(0, 8)}` : id}
                selected={activeConvId === id}
                onClick={() => onOpen(id)}
                sx={{ alignItems: 'flex-start', py: 1 }}
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {!isSearch && c.isStarred && <StarIcon sx={{ fontSize: 15, color: 'warning.main' }} />}
                      <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                        {c.title}
                      </Typography>
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
                          {c.messageCount.toLocaleString('he-IL')} הודעות
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
  );
}
