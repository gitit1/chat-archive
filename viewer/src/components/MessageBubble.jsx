import { Box, Paper, Typography, Link, Stack } from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import BuildIcon from '@mui/icons-material/Build';
import SettingsIcon from '@mui/icons-material/Settings';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ROLE = {
  user: { label: 'את/ה', icon: PersonIcon, bg: '#eef2fd', align: 'flex-end' },
  assistant: { label: 'ChatGPT', icon: SmartToyIcon, bg: '#ffffff', align: 'flex-start' },
  tool: { label: 'כלי', icon: BuildIcon, bg: '#f3f0ff', align: 'flex-start' },
  system: { label: 'מערכת', icon: SettingsIcon, bg: '#f5f5f5', align: 'flex-start' },
};

// Remove "[image: file-id]" placeholder lines — the image itself is rendered below.
function stripImagePlaceholders(text) {
  return text.replace(/^\[image:[^\]]*\]\s*$/gm, '').trim();
}

function isImage(att) {
  return (att.mime && att.mime.startsWith('image/')) ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(att.ext);
}

// Map markdown nodes to MUI components. Code blocks stay LTR; prose inherits RTL.
const mdComponents = {
  p: ({ node, ...p }) => <Typography variant="body2" sx={{ my: 0.75, lineHeight: 1.7 }} {...p} />,
  h1: ({ node, ...p }) => <Typography variant="h6" sx={{ mt: 1.5, mb: 0.5, fontWeight: 700 }} {...p} />,
  h2: ({ node, ...p }) => <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5, fontWeight: 700 }} {...p} />,
  h3: ({ node, ...p }) => <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5, fontWeight: 700 }} {...p} />,
  ul: ({ node, ...p }) => <Box component="ul" sx={{ my: 0.5, pe: 3, ps: 0 }} {...p} />,
  ol: ({ node, ...p }) => <Box component="ol" sx={{ my: 0.5, pe: 3, ps: 0 }} {...p} />,
  li: ({ node, ...p }) => <Typography component="li" variant="body2" sx={{ lineHeight: 1.7 }} {...p} />,
  a: ({ node, ...p }) => <Link target="_blank" rel="noreferrer" {...p} />,
  blockquote: ({ node, ...p }) => (
    <Box component="blockquote" sx={{ borderInlineStart: '3px solid', borderColor: 'divider', ps: 1.5, my: 1, mx: 0, color: 'text.secondary' }} {...p} />
  ),
  table: ({ node, ...p }) => (
    <Box sx={{ overflowX: 'auto', my: 1 }}>
      <Box component="table" sx={{ borderCollapse: 'collapse', '& td, & th': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 } }} {...p} />
    </Box>
  ),
  code: ({ node, inline, className, children, ...p }) =>
    inline ? (
      <Box component="code" dir="ltr" sx={{ bgcolor: 'rgba(0,0,0,0.06)', px: 0.5, borderRadius: 0.5, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} {...p}>
        {children}
      </Box>
    ) : (
      <Box
        component="pre"
        dir="ltr"
        sx={{
          bgcolor: '#1e1e2e', color: '#e4e4e7', p: 1.5, borderRadius: 1, overflowX: 'auto',
          fontSize: 13, my: 1, textAlign: 'left', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        <code>{children}</code>
      </Box>
    ),
};

export default function MessageBubble({ message }) {
  const role = ROLE[message.role] ?? ROLE.system;
  const Icon = role.icon;
  const text = stripImagePlaceholders(message.text ?? '');

  return (
    <Box sx={{ display: 'flex', justifyContent: role.align, mb: 2 }}>
      <Box sx={{ maxWidth: '88%', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, opacity: 0.7 }}>
          <Icon sx={{ fontSize: 16 }} />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {message.authorName || role.label}
          </Typography>
          {message.isHidden && (
            <Typography variant="caption" sx={{ fontStyle: 'italic' }}>· מוסתר</Typography>
          )}
        </Box>

        <Paper
          variant="outlined"
          sx={{
            bgcolor: message.isHidden ? '#fbfaf5' : role.bg,
            borderColor: message.isHidden ? 'warning.light' : 'divider',
            p: 1.5,
            borderRadius: 2,
            '& > :first-of-type': { mt: 0 },
            '& > :last-child': { mb: 0 },
          }}
        >
          {text && (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {text}
            </ReactMarkdown>
          )}

          {message.attachments.length > 0 && (
            <Stack spacing={1} sx={{ mt: text ? 1.5 : 0 }}>
              {message.attachments.map((att, i) =>
                att.url && isImage(att) ? (
                  <a key={i} href={att.url} target="_blank" rel="noreferrer">
                    <Box
                      component="img"
                      src={att.url}
                      alt={att.name || att.fileId}
                      loading="lazy"
                      sx={{ maxWidth: '100%', maxHeight: 420, borderRadius: 1, display: 'block' }}
                    />
                  </a>
                ) : att.url ? (
                  <Link key={i} href={att.url} target="_blank" rel="noreferrer"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    <InsertDriveFileIcon fontSize="small" />
                    {att.name || att.fileId}
                  </Link>
                ) : (
                  <Typography key={i} variant="caption" color="text.disabled"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    <InsertDriveFileIcon fontSize="small" />
                    {att.name || att.fileId} (הקובץ חסר בייצוא)
                  </Typography>
                )
              )}
            </Stack>
          )}
        </Paper>
      </Box>
    </Box>
  );
}
