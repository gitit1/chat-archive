import { useEffect, useState, useCallback } from 'react';
import { Box, AppBar, Toolbar, Typography, CircularProgress } from '@mui/material';
import ForumIcon from '@mui/icons-material/Forum';
import { api } from './api.js';
import ProjectSidebar from './components/ProjectSidebar.jsx';
import ConversationList from './components/ConversationList.jsx';
import ChatView from './components/ChatView.jsx';

export default function App() {
  const [projectsData, setProjectsData] = useState(null);
  const [selected, setSelected] = useState({ type: 'all', id: 'all', name: 'כל השיחות' });
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [activeConvId, setActiveConvId] = useState(() => {
    const c = new URLSearchParams(window.location.search).get('c');
    return c ? Number(c) : null;
  });
  const [search, setSearch] = useState({ query: '', results: null, loading: false });

  // Keep ?c=<id> in the URL so a conversation is bookmarkable / shareable locally.
  const openConversation = useCallback((id) => {
    setActiveConvId(id);
    const url = new URL(window.location);
    if (id == null) url.searchParams.delete('c');
    else url.searchParams.set('c', id);
    window.history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    api.projects().then(setProjectsData).catch((e) => console.error('projects', e));
  }, []);

  // Load the conversation list whenever the selected project changes (unless searching).
  useEffect(() => {
    if (search.results) return;
    setLoadingConvs(true);
    api.conversations(selected.id)
      .then((d) => setConversations(d.conversations))
      .catch((e) => console.error('conversations', e))
      .finally(() => setLoadingConvs(false));
  }, [selected.id, search.results]);

  const runSearch = useCallback(async (query) => {
    if (!query.trim()) {
      setSearch({ query: '', results: null, loading: false });
      return;
    }
    setSearch({ query, results: null, loading: true });
    try {
      const d = await api.search(query);
      setSearch({ query, results: d.results, loading: false });
    } catch (e) {
      console.error('search', e);
      setSearch({ query, results: [], loading: false });
    }
  }, []);

  const selectProject = (sel) => {
    setSearch({ query: '', results: null, loading: false });
    setSelected(sel);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" elevation={0} sx={{ zIndex: 10 }}>
        <Toolbar variant="dense">
          <ForumIcon sx={{ mr: 1 }} />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            ארכיון שיחות
          </Typography>
          {projectsData && (
            <Typography variant="body2" sx={{ mr: 2, opacity: 0.8 }}>
              {projectsData.total.toLocaleString('he-IL')} שיחות · {projectsData.projects.length} פרויקטים
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ProjectSidebar
          data={projectsData}
          selected={selected}
          onSelect={selectProject}
          onSearch={runSearch}
          searching={search.loading}
          searchQuery={search.query}
        />

        <Box
          sx={{
            width: 340,
            borderLeft: 1,
            borderRight: 1,
            borderColor: 'divider',
            overflowY: 'auto',
            bgcolor: 'background.paper',
            flexShrink: 0,
          }}
        >
          {loadingConvs || search.loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <ConversationList
              conversations={conversations}
              searchResults={search.results}
              searchQuery={search.query}
              activeConvId={activeConvId}
              onOpen={openConversation}
              headerLabel={selected.name}
            />
          )}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', bgcolor: 'background.default' }}>
          <ChatView conversationId={activeConvId} />
        </Box>
      </Box>
    </Box>
  );
}
