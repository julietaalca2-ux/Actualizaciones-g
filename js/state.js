/* Depende de: nada
   Expone: variables de estado global, caches y visitorId */
let currentUser = null;
let myProfile = null;
let viewedProfile = null;
let isFollowing = false;
let profilesCache = {};

let realtimeChannel = null;
let dmRealtimeChannel = null;
let postsRealtimeChannel = null;
let presenceChannel = null;
let onlineUsersMap = {};

let myActiveStories = [];
let storiesByUserMap = {};
let currentStoryGroupProfile = null;
let currentStoryGroupList = [];
let currentStoryGroupIndex = 0;

let mediaStream = null;
let capturedBlob = null;
let postImageBlob = null;
let currentFacingMode = 'user';
let currentZoom = 1;
let currentActiveStoryId = null;

let stagedAvatarBlob = null;
let stagedHighlightBlob = null;
let pendingStoryImageForHighlight = null;
let highlightsCacheByUser = {};
let currentHighlightItems = [];
let currentHighlightIndex = 0;
let currentHighlightObj = null;
let currentHighlightItemIds = [];
let currentHighlightOwnerId = null;
let isUploadingStory = false;
let isSavingHighlight = false;

let feedPage = 0;
const FEED_PAGE_SIZE = 10;
let feedLoading = false;
let feedHasMore = true;
let loadedPostIds = new Set();
let cachedFeedPosts = null;
let cachedFollowingIds = null;
let feedScrollPosition = 0;
let isPublishing = false;

let explorePostsCache = null;
let explorePage = 0;
const EXPLORE_PAGE_SIZE = 24;
let exploreLoading = false;
let exploreHasMore = true;

let activeConversationId = null;
let activeRecipientProfile = null;
let replyingToMessageId = null;
let replyingToSnippet = null;
let cachedConversationsList = null;
let cachedActivityEvents = null;
let renderedMessageIds = new Set();

let prefetchedProfileIds = new Set();
let prefetchedConversationIds = new Set();
let prefetchedMessagesByConv = {};

let searchTimer = null;
let dmSearchTimer = null;

let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;
let isSwipeLocked = false;
const swipeNavigationFlow = ['feed', 'messagesPage', 'explore', 'profile'];

let visitorId = localStorage.getItem('og_visitor_uuid');
if (!visitorId) {
 visitorId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
  return v.toString(16);
 });
 localStorage.setItem('og_visitor_uuid', visitorId);
}
