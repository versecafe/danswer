import {
  AuthTypeMetadata,
  getAuthTypeMetadataSS,
  getCurrentUserSS,
} from "@/lib/userSS";
import { fetchSS } from "@/lib/utilsSS";
import {
  CCPairBasicInfo,
  DocumentSet,
  Tag,
  User,
  ValidSources,
} from "@/lib/types";
import { ChatSession } from "@/app/chat/interfaces";
import { Persona } from "@/app/admin/assistants/interfaces";
import { FullEmbeddingModelResponse } from "@/app/admin/models/embedding/components/types";
import { Settings } from "@/app/admin/settings/interfaces";
import { fetchLLMProvidersSS } from "@/lib/llm/fetchLLMs";
import { LLMProviderDescriptor } from "@/app/admin/models/llm/interfaces";
import { Folder } from "@/app/chat/folders/interfaces";
import { personaComparator } from "@/app/admin/assistants/lib";
import { cookies } from "next/headers";
import {
  SIDEBAR_TOGGLED_COOKIE_NAME,
  DOCUMENT_SIDEBAR_WIDTH_COOKIE_NAME,
} from "@/components/resizable/constants";
import { hasCompletedWelcomeFlowSS } from "@/components/initialSetup/welcome/WelcomeModalWrapper";
import { fetchAssistantsSS } from "../assistants/fetchAssistantsSS";

interface FetchChatDataResult {
  user: User | null;
  chatSessions: ChatSession[];

  ccPairs: CCPairBasicInfo[];
  availableSources: ValidSources[];
  documentSets: DocumentSet[];
  assistants: Persona[];
  tags: Tag[];
  llmProviders: LLMProviderDescriptor[];
  folders: Folder[];
  openedFolders: Record<string, boolean>;
  defaultPersonaId?: number;
  toggleSidebar: boolean;
  finalDocumentSidebarInitialWidth?: number;
  shouldShowWelcomeModal: boolean;
  shouldDisplaySourcesIncompleteModal: boolean;
}

export async function fetchChatData(searchParams: {
  [key: string]: string;
}): Promise<FetchChatDataResult | { redirect: string }> {
  const tasks = [
    getAuthTypeMetadataSS(),
    getCurrentUserSS(),
    fetchSS("/manage/indexing-status"),
    fetchSS("/manage/document-set"),
    fetchAssistantsSS(),
    fetchSS("/chat/get-user-chat-sessions"),
    fetchSS("/query/valid-tags"),
    fetchLLMProvidersSS(),
    fetchSS("/folder"),
  ];

  let results: (
    | User
    | Response
    | AuthTypeMetadata
    | FullEmbeddingModelResponse
    | Settings
    | LLMProviderDescriptor[]
    | [Persona[], string | null]
    | null
  )[] = [null, null, null, null, null, null, null, null, null, null];
  try {
    results = await Promise.all(tasks);
  } catch (e) {
    console.log(`Some fetch failed for the main search page - ${e}`);
  }

  const authTypeMetadata = results[0] as AuthTypeMetadata | null;
  const user = results[1] as User | null;
  const ccPairsResponse = results[2] as Response | null;
  const documentSetsResponse = results[3] as Response | null;
  const [rawAssistantsList, assistantsFetchError] = results[4] as [
    Persona[],
    string | null,
  ];
  const chatSessionsResponse = results[5] as Response | null;

  const tagsResponse = results[6] as Response | null;
  const llmProviders = (results[7] || []) as LLMProviderDescriptor[];
  const foldersResponse = results[8] as Response | null; // Handle folders result

  const authDisabled = authTypeMetadata?.authType === "disabled";
  if (!authDisabled && !user) {
    return { redirect: "/auth/login" };
  }

  if (user && !user.is_verified && authTypeMetadata?.requiresVerification) {
    return { redirect: "/auth/waiting-on-verification" };
  }

  let ccPairs: CCPairBasicInfo[] = [];
  if (ccPairsResponse?.ok) {
    ccPairs = await ccPairsResponse.json();
  } else {
    console.log(`Failed to fetch connectors - ${ccPairsResponse?.status}`);
  }
  const availableSources: ValidSources[] = [];
  ccPairs.forEach((ccPair) => {
    if (!availableSources.includes(ccPair.source)) {
      availableSources.push(ccPair.source);
    }
  });

  let chatSessions: ChatSession[] = [];
  if (chatSessionsResponse?.ok) {
    chatSessions = (await chatSessionsResponse.json()).sessions;
  } else {
    console.log(
      `Failed to fetch chat sessions - ${chatSessionsResponse?.text()}`
    );
  }
  // Larger ID -> created later
  chatSessions.sort((a, b) => (a.id > b.id ? -1 : 1));

  let documentSets: DocumentSet[] = [];
  if (documentSetsResponse?.ok) {
    documentSets = await documentSetsResponse.json();
  } else {
    console.log(
      `Failed to fetch document sets - ${documentSetsResponse?.status}`
    );
  }

  let assistants = rawAssistantsList;
  if (assistantsFetchError) {
    console.log(`Failed to fetch assistants - ${assistantsFetchError}`);
  }
  // remove those marked as hidden by an admin
  assistants = assistants.filter((assistant) => assistant.is_visible);

  // sort them in priority order
  assistants.sort(personaComparator);

  let tags: Tag[] = [];
  if (tagsResponse?.ok) {
    tags = (await tagsResponse.json()).tags;
  } else {
    console.log(`Failed to fetch tags - ${tagsResponse?.status}`);
  }

  const defaultPersonaIdRaw = searchParams["assistantId"];
  const defaultPersonaId = defaultPersonaIdRaw
    ? parseInt(defaultPersonaIdRaw)
    : undefined;

  const documentSidebarCookieInitialWidth = cookies().get(
    DOCUMENT_SIDEBAR_WIDTH_COOKIE_NAME
  );
  const sidebarToggled = cookies().get(SIDEBAR_TOGGLED_COOKIE_NAME);

  const toggleSidebar = sidebarToggled
    ? sidebarToggled.value.toLocaleLowerCase() == "true" || false
    : false;

  const finalDocumentSidebarInitialWidth = documentSidebarCookieInitialWidth
    ? parseInt(documentSidebarCookieInitialWidth.value)
    : undefined;

  const hasAnyConnectors = ccPairs.length > 0;
  const shouldShowWelcomeModal =
    !hasCompletedWelcomeFlowSS() &&
    !hasAnyConnectors &&
    (!user || user.role === "admin");
  const shouldDisplaySourcesIncompleteModal =
    hasAnyConnectors &&
    !shouldShowWelcomeModal &&
    !ccPairs.some(
      (ccPair) => ccPair.has_successful_run && ccPair.docs_indexed > 0
    );

  // if no connectors are setup, only show personas that are pure
  // passthrough and don't do any retrieval
  if (!hasAnyConnectors) {
    assistants = assistants.filter((assistant) => assistant.num_chunks === 0);
  }

  let folders: Folder[] = [];
  if (foldersResponse?.ok) {
    folders = (await foldersResponse.json()).folders as Folder[];
  } else {
    console.log(`Failed to fetch folders - ${foldersResponse?.status}`);
  }

  const openedFoldersCookie = cookies().get("openedFolders");
  const openedFolders = openedFoldersCookie
    ? JSON.parse(openedFoldersCookie.value)
    : {};

  return {
    user,
    chatSessions,
    ccPairs,
    availableSources,
    documentSets,
    assistants,
    tags,
    llmProviders,
    folders,
    openedFolders,
    defaultPersonaId,
    finalDocumentSidebarInitialWidth,
    toggleSidebar,
    shouldShowWelcomeModal,
    shouldDisplaySourcesIncompleteModal,
  };
}
