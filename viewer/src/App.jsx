import { useEffect, useState, useCallback } from 'react';
import { Box, AppBar, Toolbar, Typography, CircularProgress, Button } from '@mui/material';
import ForumIcon from '@mui/icons-material/Forum';
import BarChartIcon from '@mui/icons-material/BarChart';
import { api } from './api.js';
import ProjectSidebar from './components/ProjectSidebar.jsx';
import ConversationList from './components/ConversationList.jsx';
import ChatView from './components/ChatView.jsx';
import StatsDialog from './components/StatsDialog.jsx';

const DEFAULT_FILTERS = { sort: 'recent', model: '', starred: false };

export default function App() {
  const [projectsData, setProjectsData] = useState(null);
  const [tags, setTags] = useState([]);
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState({ type: 'all', id: 'all', name: 'כל השיחות' });
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [activeConvId, setActiveConvId] = useState(() => {
    const c = new URLSearchParams(window.location.search).get('c');
    return c ? Number(c) : null;
  });
  const [search, setSearch] = useState({ query: '', results: null, loading: false });
  const [statsOpen, setStatsOpen] = useState(false);

  const openConversation = useCallback((id) => {
    setActiveConvId(id);
    const url = new URL(window.location);
    if (id == null) url.searchParams.delete('c');
    else url.searchParams.set('c', id);
    window.history.replaceState(null, '', url);
  }, []);

  const loadProjects = useCallback(() => api.projects().then(setProjectsData), []);
  const loadTags = useCallback(() => api.tags().then((d) => setTags(d.tags)), []);

  useEffect(() => {
    loadProjects().catch((e) => console.error('projects', e));
    loadTags().catch((e) => console.error('tags', e));
    api.models().then((d) => setModels(d.models)).catch((e) => console.error('models', e));
  }, [loadProjects, loadTags]);

  // (Re)load the conversation list on project/tag/filter change (unless searching).
  useEffect(() => {
    if (search.results) return;
    setLoadingConvs(true);
    const req = {
      project: selected.type === 'tag' ? undefined : selected.id,
      tag: selected.type === 'tag' ? selected.id : undefined,
      sort: filters.sort,
      model: filters.model,
      starred: filters.starred ? '1' : '',
    };
    api.conversations(req)
      .then((d) => setConversations(d.conversations))
      .catch((e) => console.error('conversations', e))
      .finally(() => setLoadingConvs(false));
  }, [selected, filters, search.results]);

  const runSearch = useCallback(async (query) => {
    if (!query.trim()) { setSearch({ query: '', results: null, loading: false }); return; }
    setSearch({ query, results: null, loading: true });
    try {
      const d = await api.search(query);
      setSearch({ query, results: d.results, loading: false });
    } catch (e) {
      console.error('search', e);
      setSearch({ query, results: [], loading: false });
    }
  }, []);

  const selectNav = (sel) => {
    setSearch({ query: '', results: null, loading: false });
    setSelected(sel);
  };

  // When tags change on the open conversation, refresh sidebar tag counts.
  const onTagsChanged = useCallback(() => { loadTags(); }, [loadTags]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" elevation={0} sx={{ zIndex: 10 }}>
        <Toolbar variant="dense">
          <ForumIcon sx={{ mr: 1 }} />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>ארכיון שיחות</Typography>
          {projectsData && (
            <Typography variant="body2" sx={{ mr: 2, opacity: 0.85 }}>
              {projectsData.total.toLocaleString('he-IL')} שיחות · {projectsData.projects.length} פרויקטים
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button color="inherit" size="small" startIcon={<BarChartIcon />} onClick={() => setStatsOpen(true)}>
            סטטיסטיקות
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ProjectSidebar
          data={projectsData} tags={tags} selected={selected}
          onSelect={selectNav} onSearch={runSearch}
          searching={search.loading} searchQuery={search.query}
        />

        <Box sx={{ width: 340, borderLeft: 1, borderRight: 1, borderColor: 'divider',
                   display: 'flex', flexDirection: 'column', bgcolor: 'background.paper', flexShrink: 0 }}>
          {loadingConvs || search.loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress size={28} /></Box>
          ) : (
            <ConversationList
              conversations={conversations}
              searchResults={search.results}
              searchQuery={search.query}
              activeConvId={activeConvId}
              onOpen={openConversation}
              headerLabel={selected.name}
              filters={filters}
              onFilters={setFilters}
              models={models}
            />
          )}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', bgcolor: 'background.default' }}>
          <ChatView conversationId={activeConvId} onTagsChanged={onTagsChanged} />
        </Box>
      </Box>

      <StatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} />
    </Box>
  );
}
