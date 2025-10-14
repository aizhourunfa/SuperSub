<script setup lang="ts">
import { ref, onMounted, reactive, h, computed, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, useDialog, NButton, NSpace, NTag, NDataTable, NPageHeader, NModal, NForm, NFormItem, NInput, NTooltip, NGrid, NGi, NStatistic, NCard, NSwitch, NSelect, NDynamicTags, NRadioGroup, NRadioButton, NInputGroup, NIcon, NTabs, NTabPane, NDropdown, NProgress, NCollapse, NCollapseItem, NInputNumber } from 'naive-ui'
import { EyeOutline, FilterOutline, CreateOutline, SyncOutline, TrashOutline, EllipsisVertical as MoreIcon, SettingsOutline } from '@vicons/ionicons5'
import type { DataTableColumns, FormInst, DropdownOption } from 'naive-ui'
import { Subscription, Node, ApiResponse } from '@/types'
import { api } from '@/utils/api'
import { useAuthStore } from '@/stores/auth'
import { useSubscriptionGroupStore } from '@/stores/subscriptionGroups'
import { useGroupStore as useNodeGroupStore } from '@/stores/groups'
import SubscriptionNodesPreview from '@/components/SubscriptionNodesPreview.vue'
import { format } from 'date-fns'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const subscriptionGroupStore = useSubscriptionGroupStore()
const nodeGroupStore = useNodeGroupStore()

const subscriptions = ref<Subscription[]>([])
const loading = ref(true)
const showModal = ref(false)
const saveLoading = ref(false)
const updatingId = ref<string | null>(null)
const editingSubscription = ref<Subscription | null>(null)
const updatingIds = ref(new Set<string>()) // For individual and batch updates
const activeTab = ref('all')

// For bulk import
const showImportModal = ref(false)
const importUrls = ref('')
const importLoading = ref(false)
const importGroupId = ref<string | undefined>(undefined)

// For batch actions
const checkedRowKeys = ref<string[]>([])

// For moving subscriptions to a group
const showMoveToGroupModal = ref(false)
const moveToGroupId = ref<string | null>(null)
const moveToGroupLoading = ref(false)

// For adding a new subscription group
const showAddGroupModal = ref(false)
const newGroupName = ref('')
const addGroupLoading = ref(false)

// For Group Management
const showEditGroupModal = ref(false)
const editingGroup = ref<import('@/stores/subscriptionGroups').SubscriptionGroup | null>(null)
const editingGroupName = ref('')
const editGroupLoading = ref(false)
const showDropdown = ref(false)
const dropdownX = ref(0)
const dropdownY = ref(0)
const activeDropdownGroup = ref<import('@/stores/subscriptionGroups').SubscriptionGroup | null>(null)

// For Export Group Modal
const showExportModal = ref(false)
const exportData = reactive({
  urls: '',
  count: 0,
  groupName: ''
})

// For Batch Replace Modal
const showBatchReplaceModal = ref(false)
const batchReplaceData = reactive({
  find: '',
  replace: '',
  groupId: '',
  count: 0,
  loading: false,
})

// For Node Preview in Modal
const showNodePreviewModal = ref(false)
const currentSubscriptionForPreview = ref<Subscription | null>(null)
const nodePreviewRef = ref<{ fetchPreview: () => void } | null>(null)

// For Update All Log
const showUpdateLogModal = ref(false)
const updateLog = ref<{
  success: { name: string }[]
  failed: Subscription[]
  expiring: Subscription[]
}>({ success: [], failed: [], expiring: [] })
const updateLogLoading = ref(false)
const updateProgress = ref({ current: 0, total: 0 })
let updateAbortController: AbortController | null = null
const subsToUpdate = ref<Subscription[]>([])
const updateStage = ref<'config' | 'progress'>('config')

// Update settings
const updateSettings = reactive({
  concurrency: 5,
  retries: 2,
  delay: 500, // ms delay between requests in the same batch
  batchDelay: 1000, // ms delay between batches
  expiringDaysThreshold: 2,
  expiringTrafficThresholdGB: 1,
})

// For Subscription & Group Rules (Unified)
const showRulesModal = ref(false)
const rulesLoading = ref(false)
const currentRuleContext = ref<{ type: 'subscription' | 'group', entity: Subscription | import('@/stores/subscriptionGroups').SubscriptionGroup } | null>(null)
const rules = ref<import('@/types').SubscriptionRule[]>([])
const showRuleFormModal = ref(false)
const ruleFormRef = ref<FormInst | null>(null)
const editingRule = ref<import('@/types').SubscriptionRule | null>(null)
const ruleSaveLoading = ref(false)

const ruleFormState = reactive({
  id: 0,
  name: '',
  type: 'filter_by_name_keyword' as import('@/types').SubscriptionRule['type'] | 'exclude_by_name_keyword',
  value: '',
  enabled: 1,
  keywords: [] as string[],
  renameRegex: '',
  renameFormat: '',
  regex: '',
})

const ruleModalTitle = computed(() => {
  if (!currentRuleContext.value) return '规则管理'
  const contextName = currentRuleContext.value.type === 'subscription' ? '订阅' : '分组'
  const entityName = currentRuleContext.value.entity.name
  return `${contextName}规则 - ${entityName}`
})
const ruleFormTitle = computed(() => (editingRule.value ? '编辑规则' : '新增规则'))

const ruleTypeOptions = [
  { label: '按名称关键词过滤 (保留)', value: 'filter_by_name_keyword' },
  { label: '按名称关键词排除', value: 'exclude_by_name_keyword' },
  { label: '按名称正则过滤', value: 'filter_by_name_regex' },
  { label: '按正则重命名', value: 'rename_by_regex' },
]

const commonKeywords = [
  '香港', 'HK', '🇭🇰',
  '台湾', 'TW', '🇹🇼',
  '日本', 'JP', '🇯🇵',
  '美国', 'US', '🇺🇸',
  '新加坡', 'SG', '🇸🇬',
  '韩国', 'KR', '🇰🇷',
  '英国', 'UK', '🇬🇧',
  'IEPL', 'IPLC', '专线', 'BGP',
]

const addKeyword = (keyword: string) => {
  if (!ruleFormState.keywords.includes(keyword)) {
    ruleFormState.keywords.push(keyword)
  }
}

const formState = reactive({
  id: '',
  name: '',
  url: '',
})

const modalTitle = computed(() => (editingSubscription.value ? '编辑订阅' : '新增订阅'))

const filteredSubscriptions = computed(() => {
  return subscriptions.value.filter(sub => {
    if (activeTab.value === 'all') return true
    if (activeTab.value === 'ungrouped') return !sub.group_id
    return sub.group_id === activeTab.value
  })
})

const groupCounts = computed(() => {
  const counts: { all: number; ungrouped: number; [key: string]: number } = {
    all: subscriptions.value.length,
    ungrouped: 0,
  }
  subscriptions.value.forEach(sub => {
    if (sub.group_id) {
      counts[sub.group_id] = (counts[sub.group_id] || 0) + 1
    } else {
      counts.ungrouped++
    }
  })
  return counts
})

const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


const createColumns = ({ onEdit, onUpdate, onDelete, onPreviewNodes, onManageRules }: {
    onEdit: (row: Subscription) => void,
    onUpdate: (row: Subscription) => void,
    onDelete: (row: Subscription) => void,
    onPreviewNodes: (row: Subscription) => void,
    onManageRules: (row: Subscription) => void,
}): DataTableColumns<Subscription> => {
  return [
    { type: 'selection' },
    { title: '名称', key: 'name', sorter: 'default', width: 150, ellipsis: { tooltip: true } },
    { title: '订阅链接', key: 'url', ellipsis: { tooltip: true }, width: 150 },
    {
      title: '状态',
      key: 'status',
      align: 'center',
      width: 100,
      sorter: (a, b) => {
        const getStatusValue = (row: Subscription) => {
          if (row.error) return 2; // 失败
          if (row.last_updated) return 1; // 成功
          return 0; // 待更新
        };
        return getStatusValue(a) - getStatusValue(b);
      },
      render(row) {
        if (row.error) {
          return h(NTooltip, null, {
            trigger: () => h(NTag, { type: 'error' }, { default: () => '失败' }),
            default: () => row.error
          })
        }
        if (row.last_updated) {
          return h(NTag, { type: 'success' }, { default: () => '成功' })
        }
        return h(NTag, { type: 'default' }, { default: () => '待更新' })
      }
    },
    {
      title: '节点数',
      key: 'node_count',
      align: 'center',
      width: 100,
      sorter: 'default',
      render(row) {
        const count = row.node_count ?? 0
        return h(NTag, { type: count > 0 ? 'info' : 'default', round: true }, { default: () => count })
      }
    },
    {
      title: '剩余流量',
      key: 'subscription_info',
      width: 120,
      sorter: (a, b) => {
        const valA = a.remaining_traffic;
        const valB = b.remaining_traffic;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;
        return valA - valB;
      },
      render(row) {
        const remaining = row.remaining_traffic;
        if (remaining === null || remaining === undefined || remaining < 0) {
          return h(NTag, { size: 'small', round: true }, { default: () => 'N/A' });
        }
        
        // Since we don't have total/used, we can't show a percentage-based color.
        // We can, however, create a simple color scheme based on remaining data.
        let tagType: 'success' | 'warning' | 'error' = 'success';
        const GB = 1024 * 1024 * 1024;
        if (remaining < 1 * GB) tagType = 'error';
        else if (remaining < 5 * GB) tagType = 'warning';

        return h(NTag, { type: tagType, size: 'small', round: true }, { default: () => formatBytes(remaining) });
      }
    },
    {
      title: '剩余天数',
      key: 'remaining_days',
      width: 120,
      sorter: (a, b) => {
        const valA = a.remaining_days;
        const valB = b.remaining_days;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;
        return valA - valB;
      },
      render(row) {
        const diffDays = row.remaining_days;
        if (diffDays === null || diffDays === undefined) {
            return h(NTag, { size: 'small', round: true }, { default: () => 'N/A' });
        }
        if (diffDays < 0) {
            return h(NTag, { type: 'error', size: 'small', round: true }, { default: () => '已过期' });
        }
        
        let tagType: 'success' | 'warning' | 'error' = 'success';
        if (diffDays <= 3) tagType = 'error';
        else if (diffDays <= 7) tagType = 'warning';
        
        const tooltipContent = row.expires_at ? `到期时间: ${format(new Date(row.expires_at), 'yyyy-MM-dd HH:mm')}` : '无到期时间信息';

        return h(NTooltip, null, {
          trigger: () => h(NTag, { type: tagType, size: 'small', round: true }, { default: () => `${diffDays} 天` }),
          default: () => tooltipContent,
        });
      }
    },
    {
      title: '上次更新',
      key: 'last_updated',
      width: 180,
      sorter: (a, b) => new Date(a.last_updated || 0).getTime() - new Date(b.last_updated || 0).getTime(),
      render(row) {
        return row.last_updated ? format(new Date(row.last_updated), 'yyyy-MM-dd HH:mm:ss') : 'N/A'
      }
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 200,
      render(row) {
        const createTooltipButton = (tooltip: string, icon: any, onClick: () => void, props: any = {}) => {
          return h(NTooltip, null, {
            trigger: () => h(NButton, { circle: true, tertiary: true, size: 'small', onClick, ...props }, { icon: () => h(NIcon, { component: icon }) }),
            default: () => tooltip,
          });
        };
        return h(NSpace, null, {
          default: () => [
            createTooltipButton('预览节点', EyeOutline, () => onPreviewNodes(row)),
            createTooltipButton('规则', FilterOutline, () => onManageRules(row), { type: 'info' }),
            createTooltipButton('编辑', CreateOutline, () => onEdit(row)),
            createTooltipButton('更新', SyncOutline, () => onUpdate(row), { type: 'primary', loading: updatingId.value === row.id || updatingIds.value.has(row.id) }),
            createTooltipButton('删除', TrashOutline, () => onDelete(row), { type: 'error' }),
          ]
        })
      }
    }
  ]
}

const openModal = (sub: Subscription | null = null) => {
  if (sub) {
    editingSubscription.value = { ...sub }
    formState.id = sub.id
    formState.name = sub.name
    formState.url = sub.url
  } else {
    editingSubscription.value = null
    formState.id = ''
    formState.name = ''
    formState.url = ''
  }
  showModal.value = true
}

const closeModal = () => {
  showModal.value = false
}

const fetchSubscriptions = async () => {
  const authStore = useAuthStore()
  if (!authStore.isAuthenticated) return
  loading.value = true
  try {
    const subsResponse = await api.get<ApiResponse<Subscription[]>>('/subscriptions')
    if (subsResponse.data.success && subsResponse.data.data) {
      subscriptions.value = subsResponse.data.data
    } else {
      message.error(subsResponse.data.message || '获取订阅列表失败')
    }
  } catch (err) {
    message.error('请求失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

const handleSave = async () => {
  saveLoading.value = true
  try {
    const payload = { name: formState.name, url: formState.url }
    const response = editingSubscription.value
      ? await api.put<ApiResponse>(`/subscriptions/${editingSubscription.value.id}`, payload)
      : await api.post<ApiResponse>('/subscriptions', payload)
    if (response.data.success) {
      message.success(editingSubscription.value ? '订阅更新成功' : '订阅新增成功')
      closeModal()
      fetchSubscriptions()
    } else {
      message.error(response.data.message || '保存失败')
    }
  } catch (err) {
    message.error('请求失败，请稍后重试')
  } finally {
    saveLoading.value = false
  }
}

const handleDelete = (row: Subscription) => {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除订阅 "${row.name}" 吗？`,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await api.delete<ApiResponse>(`/subscriptions/${row.id}`)
        if (response.data.success) {
          message.success('订阅删除成功')
          fetchSubscriptions()
        } else {
          message.error(response.data.message || '删除失败')
        }
      } catch (err) {
        message.error('请求失败，请稍后重试')
      }
    },
  })
}

const handleUpdate = async (row: Subscription, silent = false, signal?: AbortSignal): Promise<{ success: boolean; data: Subscription; error?: string }> => {
  updatingId.value = row.id
  updatingIds.value.add(row.id)
  if (!silent) {
    message.info(`正在更新订阅 [${row.name}]...`)
  }
  try {
    const response = await api.post<ApiResponse<Subscription>>(`/subscriptions/${row.id}/update`, {}, { signal })
    const updatedSub = response.data.data
    
    const index = subscriptions.value.findIndex(s => s.id === row.id)
    if (index !== -1 && updatedSub) {
      subscriptions.value[index] = updatedSub
    }

    if (response.data.success && updatedSub) {
      if (!silent) message.success(`订阅 [${row.name}] 更新成功`)
      return { success: true, data: updatedSub }
    } else {
      const errorMsg = response.data.message || `订阅 [${row.name}] 更新失败`
      if (!silent) message.error(errorMsg)
      // Even on failure, the backend returns the subscription state, so we use it.
      return { success: false, data: updatedSub || row, error: errorMsg }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, data: row, error: '已中止' }
    }
    const errorMsg = err.message || '请求失败，请稍后重试'
    if (!silent) message.error(errorMsg)
    return { success: false, data: row, error: errorMsg }
  } finally {
    updatingId.value = null
    updatingIds.value.delete(row.id)
  }
}


const handlePreviewNodes = (row: Subscription) => {
    currentSubscriptionForPreview.value = row
    showNodePreviewModal.value = true
    nextTick(() => {
        nodePreviewRef.value?.fetchPreview()
    })
}

const openImportModal = () => {
  importUrls.value = ''
  importGroupId.value = undefined
  showImportModal.value = true
}

// A generic function to execute updates in a concurrent pool with progress
const executeSubscriptionUpdates = async () => {
  if (subsToUpdate.value.length === 0) {
    message.info('没有需要更新的订阅')
    return
  }

  updateStage.value = 'progress'
  updateLogLoading.value = true
  message.info(`开始更新 ${subsToUpdate.value.length} 个订阅...`)

  updateAbortController = new AbortController()
  const signal = updateAbortController.signal

  const { concurrency, retries, delay } = updateSettings

  const tasks = subsToUpdate.value.map(sub => async () => {
    for (let i = 0; i <= retries; i++) {
      if (signal.aborted) return { success: false, data: sub, error: '已中止' }
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000 * i)) // Exponential backoff
      }
      const result = await handleUpdate(sub, true, signal)
      if (result.success) {
        return result
      }
      // If it's the last retry and it still fails, return the failed result
      if (i === retries) {
        return result
      }
    }
    return { success: false, data: sub, error: '未知重试错误' } // Should not be reached
  })
  
  const results = []
  const executing = new Set<Promise<void>>()

  try {
    const updatePromises = tasks.map(task => async () => {
      const result = await task()
      updateProgress.value.current++
      if (result.success) {
        const sub = result.data;
        const trafficThreshold = updateSettings.expiringTrafficThresholdGB * 1024 * 1024 * 1024;
        const isExpiring = (sub.remaining_days !== null && sub.remaining_days !== undefined && sub.remaining_days < updateSettings.expiringDaysThreshold) ||
                           (sub.remaining_traffic !== null && sub.remaining_traffic !== undefined && sub.remaining_traffic < trafficThreshold);

        if (isExpiring) {
          updateLog.value.expiring.push(sub);
        } else {
          updateLog.value.success.push({ name: sub.name });
        }
      } else {
        const failedSub = { ...result.data, error: result.error || '未知错误' };
        updateLog.value.failed.push(failedSub);
      }
      results.push(result)
    })

    for (const promiseFn of updatePromises) {
      if (signal.aborted) break

      const p = promiseFn()
      executing.add(p)

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      if (executing.size >= concurrency) {
        await Promise.race(executing)
      }
      
      p.finally(() => executing.delete(p))
    }

    await Promise.allSettled(executing)

  } catch (error) {
    console.error('An unexpected error occurred during update execution:', error)
  } finally {
    updateAbortController = null
  }
}

const prepareAndShowUpdateModal = (subs: Subscription[]) => {
  if (subs.length === 0) {
    message.info('没有需要更新的订阅')
    return
  }
  subsToUpdate.value = subs
  updateLog.value = { success: [], failed: [], expiring: [] }
  updateProgress.value = { current: 0, total: subs.length }
  updateStage.value = 'config'
  showUpdateLogModal.value = true
}

const handleUpdateAll = () => {
  const subs = checkedRowKeys.value.length > 0
    ? subscriptions.value.filter(s => checkedRowKeys.value.includes(s.id))
    : subscriptions.value.filter(s => s.enabled)
  prepareAndShowUpdateModal(subs)
}

const handleRetryFailed = () => {
  const failedSubsInfo = [...updateLog.value.failed].filter(s => s.error !== '已中止')
  prepareAndShowUpdateModal(failedSubsInfo)
}

const handleCancelUpdate = () => {
  if (updateLogLoading.value && updateAbortController) {
    updateAbortController.abort()
    updateLogLoading.value = false // Force stop loading on abort
  }
  showUpdateLogModal.value = false
}

const handleClearFailed = () => {
  const subsToClear = updateLog.value.failed.filter(sub => sub.error !== '已中止');

  if (subsToClear.length === 0) {
    message.info('没有更新失败的订阅可以清除');
    return;
  }

  dialog.warning({
    title: '确认清除失败订阅',
    content: `即将删除 ${subsToClear.length} 个更新失败的订阅，此操作不可恢复。确定要继续吗？`,
    positiveText: '确定清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const idsToClear = subsToClear.map(sub => sub.id);
      try {
        const response = await api.post('/subscriptions/batch-delete', { ids: idsToClear });
        if (response.data.success) {
          message.success(`成功清除了 ${idsToClear.length} 个失败订阅`);
          updateLog.value.failed = updateLog.value.failed.filter(sub => !idsToClear.includes(sub.id));
          fetchSubscriptions();
        } else {
          message.error(response.data.message || '清除失败');
        }
      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  });
};

const handleClearExpiring = () => {
  const subsToClear = updateLog.value.expiring;

  if (subsToClear.length === 0) {
    message.info('没有即将到期的订阅可以清除');
    return;
  }

  dialog.warning({
    title: '确认清除即将到期的订阅',
    content: `即将删除 ${subsToClear.length} 个即将到期的订阅，此操作不可恢复。确定要继续吗？`,
    positiveText: '确定清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const idsToClear = subsToClear.map(sub => sub.id);
      try {
        const response = await api.post('/subscriptions/batch-delete', { ids: idsToClear });
        if (response.data.success) {
          message.success(`成功清除了 ${idsToClear.length} 个即将到期的订阅`);
          updateLog.value.expiring = updateLog.value.expiring.filter(sub => !idsToClear.includes(sub.id));
          fetchSubscriptions();
        } else {
          message.error(response.data.message || '清除失败');
        }
      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  });
};

const handleBulkImport = async () => {
  if (!importUrls.value.trim()) {
    message.warning('请输入订阅链接')
    return
  }
  importLoading.value = true
  const lines = importUrls.value.split('\n').map(line => line.trim()).filter(Boolean)
  const subscriptionsToCreate: { name: string; url: string }[] = []
  for (const line of lines) {
    const parts = line.split(',').map(part => part.trim())
    if (parts.length === 2 && parts[1].startsWith('http')) {
      subscriptionsToCreate.push({ name: parts[0], url: parts[1] })
    } else if (parts.length === 1 && parts[0].startsWith('http')) {
      try {
        const urlObj = new URL(parts[0])
        const name = urlObj.hostname
        subscriptionsToCreate.push({ name: name, url: parts[0] })
      } catch (e) { /* Ignore invalid URL */ }
    }
  }
  if (subscriptionsToCreate.length === 0) {
    message.warning('没有找到有效的订阅链接。格式应为 "名称,链接" 或直接是链接。')
    importLoading.value = false
    return
  }
  try {
    const response = await api.post<ApiResponse>('/subscriptions/batch-import', {
      subscriptions: subscriptionsToCreate,
      groupId: importGroupId.value
    })
    if (response.data.success) {
      message.success(response.data.data?.message || `成功导入 ${response.data.data?.created || 0} 个订阅`)
      showImportModal.value = false
      fetchSubscriptions()
    } else {
      message.error(response.data.message || '导入失败')
    }
  } catch (error) {
    message.error('请求失败，请稍后重试')
  } finally {
    importLoading.value = false
  }
}

const handleBatchDelete = () => {
  if (checkedRowKeys.value.length === 0) {
    message.warning('请至少选择一个订阅');
    return;
  }
  dialog.warning({
    title: '确认批量删除',
    content: `确定要删除选中的 ${checkedRowKeys.value.length} 个订阅吗？`,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await api.post('/subscriptions/batch-delete', { ids: checkedRowKeys.value });
        if (response.data.success) {
          message.success('批量删除成功');
          fetchSubscriptions();
          checkedRowKeys.value = [];
        } else {
          message.error(response.data.message || '批量删除失败');
        }
      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  });
};

const handleClearCurrentGroup = () => {
  const tab = activeTab.value;
  let groupName = '';
  let subCount = 0;

  if (tab === 'all') {
    groupName = '全部';
    subCount = subscriptions.value.length;
  } else if (tab === 'ungrouped') {
    groupName = '未分组';
    subCount = groupCounts.value.ungrouped;
  } else {
    const group = subscriptionGroupStore.groups.find(g => g.id === tab);
    if (group) {
      groupName = group.name;
      subCount = groupCounts.value[tab] || 0;
    }
  }

  if (subCount === 0) {
    message.info(`“${groupName}”内没有可清除的订阅。`);
    return;
  }

  dialog.warning({
    title: '确认清除',
    content: `确定要删除“${groupName}”分组下的全部 ${subCount} 个订阅吗？此操作不可恢复。`,
    positiveText: '确定清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        let response;
        if (tab === 'all') {
          response = await api.post('/subscriptions/clear-all');
        } else {
          const groupId = tab === 'ungrouped' ? null : tab;
          response = await api.post('/subscriptions/clear-by-group', { groupId });
        }

        if (response.data.success) {
          message.success(response.data.message || '清除成功');
          fetchSubscriptions();
          checkedRowKeys.value = [];
        } else {
          message.error(response.data.message || '清除失败');
        }
      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  });
};

const handleClearAllFailed = () => {
  const tab = activeTab.value;
  const failedSubs = filteredSubscriptions.value.filter(sub => sub.error);

  let groupName = '';
  if (tab === 'all') {
    groupName = '全部';
  } else if (tab === 'ungrouped') {
    groupName = '未分组';
  } else {
    const group = subscriptionGroupStore.groups.find(g => g.id === tab);
    if (group) {
      groupName = group.name;
    }
  }

  if (failedSubs.length === 0) {
    message.info(`“${groupName}”分组内没有失败的订阅可清除。`);
    return;
  }

  dialog.warning({
    title: `确认清除“${groupName}”分组内的失败订阅`,
    content: `检测到 ${failedSubs.length} 个失败的订阅。确定要全部删除吗？此操作不可恢复。`,
    positiveText: '确定清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const groupId = tab === 'all' ? 'all' : (tab === 'ungrouped' ? null : tab);
        const response = await api.post('/subscriptions/clear-failed', { groupId });
        if (response.data.success) {
          message.success(response.data.message || `成功清除了 ${failedSubs.length} 个失败订阅`);
          fetchSubscriptions();
        } else {
          message.error(response.data.message || '清除失败');
        }
      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  });
};

const handleMoveToGroup = async () => {
  if (checkedRowKeys.value.length === 0) {
    message.warning('请至少选择一个订阅');
    return;
  }
  moveToGroupLoading.value = true;
  try {
    const response = await api.post('/subscriptions/batch-update-group', {
      subscriptionIds: checkedRowKeys.value,
      groupId: moveToGroupId.value,
    });
    if (response.data.success) {
      message.success('订阅分组更新成功');
      showMoveToGroupModal.value = false;
      checkedRowKeys.value = [];
      fetchSubscriptions();
    } else {
      message.error(response.data.message || '移动失败');
    }
  } catch (error: any) {
    message.error(error.message || '请求失败');
  } finally {
    moveToGroupLoading.value = false;
  }
};

const handleSaveGroup = async () => {
  if (!newGroupName.value.trim()) {
    message.warning('分组名称不能为空');
    return;
  }
  addGroupLoading.value = true;
  try {
    const response = await subscriptionGroupStore.addGroup(newGroupName.value);
    if (response.success) {
      message.success('分组创建成功');
      showAddGroupModal.value = false;
      newGroupName.value = '';
    } else {
      message.error(response.message || '创建失败');
    }
  } catch (error: any) {
    message.error(error.message || '创建失败');
  } finally {
    addGroupLoading.value = false;
  }
};

const handleUpdateGroup = async () => {
  if (!editingGroup.value || !editingGroupName.value.trim()) {
    message.warning('分组名称不能为空')
    return
  }
  editGroupLoading.value = true
  try {
    const response = await subscriptionGroupStore.updateGroup(editingGroup.value.id, editingGroupName.value)
    if (response.success) {
      message.success('分组更新成功')
      showEditGroupModal.value = false
    } else {
      message.error(response.message || '更新失败')
    }
  } catch (error: any) {
    message.error(error.message || '更新失败')
  } finally {
    editGroupLoading.value = false
  }
}

const getDropdownOptions = (group: import('@/stores/subscriptionGroups').SubscriptionGroup): DropdownOption[] => {
  return [
    { label: '更新本组', key: 'update-group' },
    { label: '一键去重', key: 'deduplicate-group' },
    { label: '导出订阅', key: 'export-group' },
    { label: '分组规则', key: 'group-rules' },
    { type: 'divider', key: 'd1' },
    { label: '批量替换', key: 'batch-replace-group' },
    { label: '重命名', key: 'rename' },
    { label: group.is_enabled ? '禁用' : '启用', key: 'toggle' },
    { type: 'divider', key: 'd2' },
    { label: '删除', key: 'delete', props: { style: 'color: red;' } }
  ]
}

const handleGroupAction = (key: string) => {
  showDropdown.value = false
  const group = activeDropdownGroup.value
  if (!group) return

  switch (key) {
    case 'update-group':
      handleUpdateGroupSubscriptions(group.id)
      break
    case 'deduplicate-group':
      handleDeduplicateGroup(group.id)
      break
    case 'export-group':
      handleExportGroup(group.id)
      break
    case 'batch-replace-group':
      openBatchReplaceModal(group.id)
      break
    case 'group-rules':
      onManageRules(group, 'group')
      break
    case 'rename':
      editingGroup.value = group
      editingGroupName.value = group.name
      showEditGroupModal.value = true
      break
    case 'toggle':
      subscriptionGroupStore.toggleGroup(group.id).catch((err: any) => message.error(err.message || '操作失败'))
      break
    case 'delete':
      dialog.warning({
        title: '确认删除',
        content: `确定要删除分组 "${group.name}" 吗？分组下的订阅将变为“未分组”。`,
        positiveText: '确定',
        negativeText: '取消',
        onPositiveClick: async () => {
          try {
            const response = await subscriptionGroupStore.deleteGroup(group.id)
            if (response.success) {
              message.success('分组删除成功')
              if (activeTab.value === group.id) {
                activeTab.value = 'all'
              }
              fetchSubscriptions() // Refresh subscriptions to update their group status
            } else {
              message.error(response.message || '删除失败')
            }
          } catch (error: any) {
            message.error(error.message || '删除失败')
          }
        }
      })
      break
  }
}

const handleTabClick = (group: import('@/stores/subscriptionGroups').SubscriptionGroup, event: MouseEvent) => {
  const target = event.target as HTMLElement
  if (target.closest('.group-actions-button')) {
    showDropdown.value = true
    dropdownX.value = event.clientX
    dropdownY.value = event.clientY
    activeDropdownGroup.value = group
  } else {
    activeTab.value = group.id
  }
}

const handleContextMenu = (group: import('@/stores/subscriptionGroups').SubscriptionGroup, event: MouseEvent) => {
  event.preventDefault()
  showDropdown.value = false
  setTimeout(() => {
    showDropdown.value = true
    dropdownX.value = event.clientX
    dropdownY.value = event.clientY
    activeDropdownGroup.value = group
  }, 50)
}

const handleUpdateGroupSubscriptions = (groupId: string) => {
  const subs = subscriptions.value.filter(s => s.group_id === groupId && s.enabled)
  prepareAndShowUpdateModal(subs)
}

const handleDeduplicateGroup = (groupId: string) => {
  const subsInGroup = subscriptions.value.filter(s => s.group_id === groupId)
  const urlMap = new Map<string, Subscription[]>()

  subsInGroup.forEach(sub => {
    const existing = urlMap.get(sub.url)
    if (existing) {
      existing.push(sub)
    } else {
      urlMap.set(sub.url, [sub])
    }
  })

  const idsToDelete: string[] = []
  urlMap.forEach(subs => {
    if (subs.length > 1) {
      // Keep the first one, delete the rest
      subs.slice(1).forEach(sub => idsToDelete.push(sub.id))
    }
  })

  if (idsToDelete.length === 0) {
    message.info('该分组内没有发现重复的订阅链接。')
    return
  }

  const totalCount = subsInGroup.length
  const duplicatesCount = idsToDelete.length
  const remainingCount = totalCount - duplicatesCount

  dialog.warning({
    title: '确认去重',
    content: () => h('div', null, [
      h('p', null, `分组内共有 ${totalCount} 条订阅。`),
      h('p', null, `检测到 ${duplicatesCount} 条重复订阅。`),
      h('p', null, `去重后将剩余 ${remainingCount} 条。`),
    ]),
    positiveText: '确定删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const chunkSize = 50;
      const chunks = [];
      for (let i = 0; i < idsToDelete.length; i += chunkSize) {
        chunks.push(idsToDelete.slice(i, i + chunkSize));
      }

      try {
        let successCount = 0;
        let hasError = false;

        for (const chunk of chunks) {
          const response = await api.post('/subscriptions/batch-delete', { ids: chunk });
          if (response.data.success) {
            // Assuming the backend doesn't return the count for each chunk,
            // we just proceed. The final message will use the total count.
          } else {
            hasError = true;
            message.error(response.data.message || `一批订阅删除失败`);
            // Stop on first error
            break;
          }
        }

        if (!hasError) {
          message.success(`成功删除了 ${duplicatesCount} 个重复订阅。`);
        } else {
          message.warning('部分重复订阅删除失败，请刷新后重试。');
        }
        
        fetchSubscriptions();

      } catch (err) {
        message.error('请求失败，请稍后重试');
      }
    }
  })
}

const handleExportGroup = (groupId: string) => {
  const group = subscriptionGroupStore.groups.find(g => g.id === groupId)
  const subsInGroup = subscriptions.value.filter(s => s.group_id === groupId)
  if (subsInGroup.length === 0) {
    message.warning('该分组下没有订阅可导出。')
    return
  }

  exportData.urls = subsInGroup.map(s => s.url).join('\n')
  exportData.count = subsInGroup.length
  exportData.groupName = group?.name || '该分组'
  showExportModal.value = true
}

const handleCopyExportUrls = () => {
  if (!exportData.urls) {
    message.warning('没有内容可复制。')
    return
  }
  navigator.clipboard.writeText(exportData.urls).then(() => {
    message.success('已成功复制到剪贴板！')
  }).catch(err => {
    message.error('复制失败，您的浏览器可能不支持或未授权。')
    console.error('Clipboard write failed:', err)
  })
}


const openBatchReplaceModal = (groupId: string) => {
  const subsInGroup = subscriptions.value.filter(s => s.group_id === groupId)
  if (subsInGroup.length === 0) {
    message.warning('该分组下没有订阅可进行批量替换。')
    return
  }
  batchReplaceData.find = ''
  batchReplaceData.replace = ''
  batchReplaceData.groupId = groupId
  batchReplaceData.count = subsInGroup.length
  batchReplaceData.loading = false
  showBatchReplaceModal.value = true
}

const handleBatchReplace = async () => {
  if (!batchReplaceData.find) {
    message.warning('“查找”内容不能为空。')
    return
  }
  if (batchReplaceData.groupId === '') {
    message.error('未指定分组，操作中止。')
    return
  }

  batchReplaceData.loading = true
  const subsToUpdate = subscriptions.value.filter(s => s.group_id === batchReplaceData.groupId)
  
  const updates = subsToUpdate.map(sub => ({
    id: sub.id,
    url: sub.url.replaceAll(batchReplaceData.find, batchReplaceData.replace)
  })).filter(update => {
    const originalSub = subsToUpdate.find(s => s.id === update.id)
    return originalSub && originalSub.url !== update.url
  })

  if (updates.length === 0) {
    message.info('没有找到任何需要更新的订阅链接。')
    batchReplaceData.loading = false
    showBatchReplaceModal.value = false
    return
  }

  try {
    const response = await api.post('/subscriptions/batch-update-urls', { updates })
    if (response.data.success) {
      message.success(`成功更新了 ${updates.length} 个订阅链接。`)
      fetchSubscriptions()
      showBatchReplaceModal.value = false
    } else {
      message.error(response.data.message || '批量替换失败')
    }
  } catch (err) {
    message.error('请求失败，请稍后重试')
  } finally {
    batchReplaceData.loading = false
  }
}


// --- Unified Rules Logic ---
const fetchRules = async () => {
  if (!currentRuleContext.value) return
  rulesLoading.value = true
  const { type, entity } = currentRuleContext.value
  const baseUrl = type === 'subscription' ? '/subscriptions' : '/subscription-groups'
  
  try {
    const response = await api.get<ApiResponse<import('@/types').SubscriptionRule[]>>(`${baseUrl}/${entity.id}/rules`)
    if (response.data.success) {
      rules.value = response.data.data || []
    } else {
      message.error(response.data.message || '获取规则列表失败')
    }
  } catch (e) {
    message.error('请求规则列表失败')
  } finally {
    rulesLoading.value = false
  }
}

const onManageRules = (entity: Subscription | import('@/stores/subscriptionGroups').SubscriptionGroup, type: 'subscription' | 'group') => {
  currentRuleContext.value = { type, entity }
  showRulesModal.value = true
  fetchRules()
}

const handleDeleteRule = (rule: import('@/types').SubscriptionRule) => {
  if (!currentRuleContext.value) return
  const { type, entity } = currentRuleContext.value
  const baseUrl = type === 'subscription' ? '/subscriptions' : '/subscription-groups'

  dialog.warning({
    title: '确认删除规则',
    content: `确定要删除规则 "${rule.name}" 吗？`,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await api.delete<ApiResponse>(`${baseUrl}/${entity.id}/rules/${rule.id}`)
        if (response.data.success) {
          message.success('规则删除成功')
          fetchRules()
        } else {
          message.error(response.data.message || '删除失败')
        }
      } catch (err) {
        message.error('请求失败，请稍后重试')
      }
    },
  })
}

const openRuleFormModal = (rule: import('@/types').SubscriptionRule | null) => {
  ruleFormState.id = 0
  ruleFormState.name = ''
  ruleFormState.type = 'filter_by_name_keyword'
  ruleFormState.value = ''
  ruleFormState.enabled = 1
  ruleFormState.keywords = []
  ruleFormState.renameRegex = ''
  ruleFormState.renameFormat = ''
  ruleFormState.regex = ''
  editingRule.value = null
  if (rule) {
    editingRule.value = rule
    ruleFormState.id = rule.id
    ruleFormState.name = rule.name
    ruleFormState.type = rule.type
    ruleFormState.value = rule.value
    ruleFormState.enabled = rule.enabled
    try {
      const parsedValue = JSON.parse(rule.value)
      if ((rule.type === 'filter_by_name_keyword' || rule.type === 'exclude_by_name_keyword') && parsedValue.keywords) {
        ruleFormState.keywords = parsedValue.keywords
      } else if (rule.type === 'rename_by_regex' && parsedValue.regex && parsedValue.format) {
        ruleFormState.renameRegex = parsedValue.regex
        ruleFormState.renameFormat = parsedValue.format
      } else if (rule.type === 'filter_by_name_regex' && parsedValue.regex) {
        ruleFormState.regex = parsedValue.regex
      }
    } catch (e) {
      console.error("Failed to parse rule value JSON:", e)
    }
  }
  showRuleFormModal.value = true
}

const handleSaveRule = async () => {
  if (!currentRuleContext.value) return
  const { type, entity } = currentRuleContext.value
  const baseUrl = type === 'subscription' ? '/subscriptions' : '/subscription-groups'
  
  ruleSaveLoading.value = true
  try {
    let jsonValue = {}
    if (ruleFormState.type === 'filter_by_name_keyword' || ruleFormState.type === 'exclude_by_name_keyword') {
      jsonValue = { keywords: ruleFormState.keywords }
    } else if (ruleFormState.type === 'rename_by_regex') {
      jsonValue = { regex: ruleFormState.renameRegex, format: ruleFormState.renameFormat }
    } else if (ruleFormState.type === 'filter_by_name_regex') {
      jsonValue = { regex: ruleFormState.regex }
    } else {
      try {
        jsonValue = JSON.parse(ruleFormState.value)
      } catch (e) {
        message.error('规则值的JSON格式无效')
        ruleSaveLoading.value = false
        return
      }
    }
    const payload = {
      name: ruleFormState.name,
      type: ruleFormState.type,
      value: JSON.stringify(jsonValue),
      enabled: ruleFormState.enabled === 1,
    }
    let response;
    if (editingRule.value) {
      response = await api.put<ApiResponse>(`${baseUrl}/${entity.id}/rules/${editingRule.value.id}`, payload)
    } else {
      response = await api.post<ApiResponse>(`${baseUrl}/${entity.id}/rules`, payload)
    }
    if (response.data.success) {
      message.success(editingRule.value ? '规则更新成功' : '规则创建成功')
      showRuleFormModal.value = false
      fetchRules()
    } else {
      message.error(response.data.message || '保存失败')
    }
  } catch (err) {
    message.error('请求失败')
  } finally {
    ruleSaveLoading.value = false
  }
}

const createRuleColumns = ({ onEdit, onDelete }: {
    onEdit: (row: import('@/types').SubscriptionRule) => void,
    onDelete: (row: import('@/types').SubscriptionRule) => void,
}): DataTableColumns<import('@/types').SubscriptionRule> => {
  return [
    { title: '名称', key: 'name', width: 150 },
    {
      title: '类型',
      key: 'type',
      width: 180,
      render(row) {
        const option = ruleTypeOptions.find(o => o.value === row.type)
        return option ? option.label : row.type
      }
    },
    { title: '规则值', key: 'value', ellipsis: { tooltip: true } },
    {
      title: '启用',
      key: 'enabled',
      width: 80,
      align: 'center',
      render(row) {
        return h(NSwitch, {
          value: row.enabled === 1,
          onUpdateValue: async (value) => {
            if (!currentRuleContext.value) return
            const { type, entity } = currentRuleContext.value
            const baseUrl = type === 'subscription' ? '/subscriptions' : '/subscription-groups'
            
            row.enabled = value ? 1 : 0
            try {
              await api.put<ApiResponse>(`${baseUrl}/${entity.id}/rules/${row.id}`, { enabled: value })
              message.success('状态更新成功')
            } catch (e) {
              message.error('状态更新失败')
              row.enabled = !value ? 1 : 0
            }
          }
        })
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render(row) {
        return h(NSpace, null, {
          default: () => [
            h(NButton, { size: 'small', onClick: () => onEdit(row) }, { default: () => '编辑' }),
            h(NButton, { size: 'small', type: 'error', ghost: true, onClick: () => onDelete(row) }, { default: () => '删除' }),
          ]
        })
      }
    }
  ]
}

const ruleColumns = createRuleColumns({
  onEdit: openRuleFormModal,
  onDelete: handleDeleteRule,
})

const columns = createColumns({
    onEdit: openModal,
    onUpdate: handleUpdate,
    onDelete: handleDelete,
    onPreviewNodes: handlePreviewNodes,
    onManageRules: (sub) => onManageRules(sub, 'subscription'),
})

onMounted(() => {
  fetchSubscriptions()
  subscriptionGroupStore.fetchGroups()
  nodeGroupStore.fetchGroups()

  // Load update settings from localStorage
  const savedSettings = localStorage.getItem('subscriptionUpdateSettings')
  if (savedSettings) {
    Object.assign(updateSettings, JSON.parse(savedSettings))
  }

  // Watch for changes and save to localStorage
  watch(updateSettings, (newSettings: typeof updateSettings) => {
    localStorage.setItem('subscriptionUpdateSettings', JSON.stringify(newSettings))
  })

  // Watch for the progress to complete
  watch(updateProgress, (progress) => {
    if (progress.total > 0 && progress.current === progress.total) {
      // Use nextTick to ensure the final progress number is rendered before showing the message
      nextTick(() => {
        if (updateLogLoading.value) { // Check if it's still considered loading
          message.success('订阅更新任务完成！')
          if (checkedRowKeys.value.length > 0) {
            checkedRowKeys.value = []
          }
          fetchSubscriptions()
          updateLogLoading.value = false
        }
      })
    }
  }, { deep: true })
})
</script>

<template>
  <div>
    <n-page-header>
      <template #title>
        订阅管理
      </template>
      <template #extra>
        <n-space>
          <n-button type="primary" ghost @click="handleUpdateAll" :loading="updatingIds.size > 0">
            {{ checkedRowKeys.length > 0 ? `更新选中 (${checkedRowKeys.length})` : '更新全部' }}
          </n-button>
          <n-button type="primary" @click="openModal(null)">新增订阅</n-button>
          <n-button type="info" @click="openImportModal">批量导入</n-button>
          <n-button type="primary" ghost @click="showAddGroupModal = true">新增分组</n-button>
          <n-button type="primary" ghost @click="showMoveToGroupModal = true" :disabled="checkedRowKeys.length === 0">移动到分组</n-button>
          <n-button type="error" ghost @click="handleBatchDelete" :disabled="checkedRowKeys.length === 0">批量删除</n-button>
          <n-button type="error" ghost @click="handleClearAllFailed">清除失败项</n-button>
          <n-button type="error" @click="handleClearCurrentGroup">一键清除</n-button>
        </n-space>
      </template>
    </n-page-header>

    <n-tabs type="card" class="mt-4" v-model:value="activeTab" @update:value="showDropdown = false">
      <n-tab-pane name="all" :tab="`全部 (${groupCounts.all})`" />
      <n-tab-pane name="ungrouped" :tab="`未分组 (${groupCounts.ungrouped})`" />
      <n-tab-pane
        v-for="group in subscriptionGroupStore.groups"
        :key="group.id"
        :name="group.id"
      >
        <template #tab>
          <div
            class="group-tab-wrapper"
            @click.prevent="handleTabClick(group, $event)"
            @contextmenu.prevent="handleContextMenu(group, $event)"
          >
            <span :style="{ color: group.is_enabled ? '' : '#999', marginRight: '8px' }">
              {{ group.name }} ({{ groupCounts[group.id] || 0 }})
            </span>
            <n-button v-if="activeTab === group.id" text class="group-actions-button">
              <n-icon :component="MoreIcon" />
            </n-button>
          </div>
        </template>
      </n-tab-pane>
    </n-tabs>

    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="dropdownX"
      :y="dropdownY"
      :options="activeDropdownGroup ? getDropdownOptions(activeDropdownGroup) : []"
      :show="showDropdown"
      @select="handleGroupAction"
      @clickoutside="showDropdown = false"
    />

    <n-data-table
      :columns="columns"
      :data="filteredSubscriptions"
      :loading="loading"
      :pagination="{ pageSize: 10 }"
      :bordered="false"
      class="mt-4"
      v-model:checked-row-keys="checkedRowKeys"
      :row-key="(row: Subscription) => row.id"
      :scroll-x="1800"
    />

    <n-modal
      v-model:show="showModal"
      :mask-closable="false"
      preset="dialog"
      :title="modalTitle"
      :positive-button-props="{ loading: saveLoading }"
      positive-text="保存"
      negative-text="取消"
      @positive-click="handleSave"
      @negative-click="closeModal"
    >
      <n-form>
        <n-form-item label="名称" required>
          <n-input v-model:value="formState.name" placeholder="为订阅起个名字" />
        </n-form-item>
        <n-form-item label="URL" required>
          <n-input v-model:value="formState.url" placeholder="输入订阅链接" />
        </n-form-item>
      </n-form>
    </n-modal>

    <n-modal
      v-model:show="showImportModal"
      preset="card"
      title="批量导入订阅"
      style="width: 600px;"
      :mask-closable="false"
    >
      <n-form @submit.prevent="handleBulkImport">
        <n-form-item label="订阅链接">
          <n-input
            v-model:value="importUrls"
            type="textarea"
            placeholder="每行一个订阅，格式为 “名称,链接” 或直接是链接。"
            :autosize="{ minRows: 10, maxRows: 20 }"
          />
        </n-form-item>
        <n-form-item label="导入到分组">
          <n-select
            v-model:value="importGroupId"
            placeholder="默认导入到“未分组”"
            :options="subscriptionGroupStore.groups.map(g => ({ label: g.name, value: g.id }))"
            clearable
          />
        </n-form-item>
        <n-space justify="end">
          <n-button @click="showImportModal = false">取消</n-button>
          <n-button type="primary" @click="handleBulkImport" :loading="importLoading">导入</n-button>
        </n-space>
      </n-form>
    </n-modal>


    <n-modal
      v-model:show="showNodePreviewModal"
      preset="card"
      :title="`节点预览 - ${currentSubscriptionForPreview?.name}`"
      style="width: 800px;"
      :mask-closable="true"
    >
      <SubscriptionNodesPreview
        ref="nodePreviewRef"
        v-if="currentSubscriptionForPreview"
        :subscription-id="currentSubscriptionForPreview.id"
        :subscription-url="currentSubscriptionForPreview.url"
        :profile-id="currentSubscriptionForPreview.profile_id || undefined"
        :show="showNodePreviewModal"
      />
    </n-modal>

    <n-modal
      v-model:show="showRulesModal"
      preset="card"
      :title="ruleModalTitle"
      style="width: 900px;"
      :mask-closable="false"
    >
      <n-space justify="end" class="mb-4">
        <n-button type="primary" @click="openRuleFormModal(null)">添加规则</n-button>
      </n-space>
      <n-data-table
        :columns="ruleColumns"
        :data="rules"
        :loading="rulesLoading"
        :bordered="false"
      />
    </n-modal>

    <n-modal
      v-model:show="showRuleFormModal"
      :mask-closable="false"
      preset="dialog"
      :title="ruleFormTitle"
      positive-text="保存"
      negative-text="取消"
      :positive-button-props="{ loading: ruleSaveLoading }"
      @positive-click="handleSaveRule"
    >
      <n-form ref="ruleFormRef">
        <n-form-item label="规则名称" required>
          <n-input v-model:value="ruleFormState.name" placeholder="为规则起个名字" />
        </n-form-item>
        <n-form-item label="规则类型" required>
          <n-select v-model:value="ruleFormState.type" :options="ruleTypeOptions" />
        </n-form-item>
        <n-form-item v-if="ruleFormState.type === 'filter_by_name_keyword' || ruleFormState.type === 'exclude_by_name_keyword'" label="关键词" required>
          <n-dynamic-tags v-model:value="ruleFormState.keywords" />
          <template #feedback>
            <span v-if="ruleFormState.type === 'filter_by_name_keyword'">保留节点名包含任意一个关键词的节点。输入后按回车确认。</span>
            <span v-else>排除节点名包含任意一个关键词的节点。输入后按回车确认。</span>
          </template>
          
          <div class="mt-2">
            <p class="text-xs text-gray-500 mb-1">常用标签 (点击添加):</p>
            <n-space :size="'small'" style="flex-wrap: wrap;">
              <n-tag
                v-for="keyword in commonKeywords"
                :key="keyword"
                size="small"
                :bordered="false"
                type="info"
                style="cursor: pointer;"
                @click="addKeyword(keyword)"
              >
                {{ keyword }}
              </n-tag>
            </n-space>
          </div>
        </n-form-item>

        <n-form-item v-else-if="ruleFormState.type === 'rename_by_regex'" label="重命名规则" required>
          <n-space vertical style="width: 100%;">
            <n-input v-model:value="ruleFormState.renameRegex" placeholder="匹配规则 (Regex)" />
            <div class="text-xs text-gray-400 mt-1">
              <p>示例 1: 从 "[HK] Node 01" 提取 "HK" 和 "01", 可用 `^\[(.*)\]\s.*(\d+)$`</p>
              <p>示例 2: 提取 "HK-专线-01" 中的 "HK" 和 "专线", 可用 `(HK)-(专线)`</p>
            </div>
            <n-input v-model:value="ruleFormState.renameFormat" placeholder="重命名格式" class="mt-2" />
            <div class="text-xs text-gray-400 mt-1">
              <p>用法: `$1`, `$2` 代表上方匹配规则中的第1、2个括号捕获的内容。</p>
              <p>示例 1: `NewName-$1-$2` 会得到 "NewName-HK-01"。</p>
              <p>示例 2: `[$2] $1` 会得到 "[专线] HK"。</p>
            </div>
          </n-space>
        </n-form-item>

        <n-form-item v-else-if="ruleFormState.type === 'filter_by_name_regex'" label="正则表达式" required>
          <n-input
            v-model:value="ruleFormState.regex"
            placeholder="输入用于过滤的正则表达式"
          />
          <template #feedback>
            <p>保留节点名匹配正则表达式的节点。</p>
            <p><b>用法示例:</b></p>
            <ul class="list-disc list-inside">
              <li>匹配多个关键词 (香港或澳门): `香港|澳门`</li>
              <li>匹配IEPL且不含广州: `IEPL.*(?!广州)`</li>
              <li>不区分大小写匹配 "iepl": `(?i)iepl`</li>
              <li>匹配包含 "VIP" 但不包含 "过期" 的节点: `^(?=.*VIP)(?!.*过期)`</li>
            </ul>
          </template>
        </n-form-item>

        <n-form-item v-else label="规则值 (JSON)" required>
          <n-input
            v-model:value="ruleFormState.value"
            type="textarea"
            placeholder='这是一个兼容旧版或未知规则类型的输入框'
            :autosize="{ minRows: 3, maxRows: 5 }"
          />
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="ruleFormState.enabled" :checked-value="1" :unchecked-value="0" />
        </n-form-item>
      </n-form>
    </n-modal>

    <n-modal
      v-model:show="showMoveToGroupModal"
      preset="card"
      title="移动订阅到分组"
      style="width: 400px;"
      :mask-closable="false"
    >
      <n-form @submit.prevent="handleMoveToGroup">
        <n-form-item label="目标分组" required>
          <n-select
            v-model:value="moveToGroupId"
            placeholder="请选择目标分组（可清空变为未分组）"
            :options="subscriptionGroupStore.groups.map(g => ({ label: g.name, value: g.id }))"
            clearable
          />
        </n-form-item>
        <n-space justify="end">
          <n-button @click="showMoveToGroupModal = false">取消</n-button>
          <n-button type="primary" @click="handleMoveToGroup" :loading="moveToGroupLoading">确认移动</n-button>
        </n-space>
      </n-form>
    </n-modal>

    <n-modal
      v-model:show="showAddGroupModal"
      preset="card"
      title="新增分组"
      style="width: 400px;"
      :mask-closable="false"
    >
      <n-form @submit.prevent="handleSaveGroup">
        <n-form-item label="分组名称" required>
          <n-input v-model:value="newGroupName" placeholder="请输入分组名称" />
        </n-form-item>
        <n-space justify="end">
          <n-button @click="showAddGroupModal = false">取消</n-button>
          <n-button type="primary" @click="handleSaveGroup" :loading="addGroupLoading">保存</n-button>
        </n-space>
      </n-form>
    </n-modal>

    <n-modal
      v-model:show="showEditGroupModal"
      preset="card"
      title="重命名分组"
      style="width: 400px;"
      :mask-closable="false"
    >
      <n-form @submit.prevent="handleUpdateGroup">
        <n-form-item label="新名称" required>
          <n-input v-model:value="editingGroupName" placeholder="请输入新的分组名称" />
        </n-form-item>
        <n-space justify="end">
          <n-button @click="showEditGroupModal = false">取消</n-button>
          <n-button type="primary" @click="handleUpdateGroup" :loading="editGroupLoading">保存</n-button>
        </n-space>
      </n-form>
    </n-modal>

    <n-modal
      v-model:show="showUpdateLogModal"
      preset="card"
      title="订阅更新"
      style="width: 600px;"
      :mask-closable="false"
    >
      <!-- Configuration Stage -->
      <div v-if="updateStage === 'config'">
        <n-form label-placement="left" label-width="auto">
          <n-form-item label="待更新订阅数">
            <n-statistic :value="subsToUpdate.length" />
          </n-form-item>
          <n-form-item label="并发数">
            <n-input-number v-model:value="updateSettings.concurrency" :min="1" :max="20" />
            <template #feedback>同时执行的网络请求数量。较高的值可以加快速度，但可能导致请求失败。</template>
          </n-form-item>
          <n-form-item label="失败重试次数">
            <n-input-number v-model:value="updateSettings.retries" :min="0" :max="5" />
            <template #feedback>每个订阅在更新失败后自动重试的次数。</template>
          </n-form-item>
          <n-form-item label="请求间隔 (ms)">
            <n-input-number v-model:value="updateSettings.delay" :min="0" :step="100" />
            <template #feedback>同一批次内，每个并发请求之间的间隔。有助于错开请求峰值。</template>
          </n-form-item>
          <n-form-item label="批次间隔 (ms)">
            <n-input-number v-model:value="updateSettings.batchDelay" :min="0" :step="100" />
            <template #feedback>每完成一个并发批次后，等待一段时间再开始下一个批次。</template>
          </n-form-item>
          <n-form-item label="到期天数阈值">
           <n-input-number v-model:value="updateSettings.expiringDaysThreshold" :min="0" :step="1" />
           <template #feedback>当剩余天数小于此值时，将归类为“即将到期”。</template>
         </n-form-item>
         <n-form-item label="到期流量阈值 (GB)">
           <n-input-number v-model:value="updateSettings.expiringTrafficThresholdGB" :min="0" :step="1" />
           <template #feedback>当剩余流量小于此值 (GB) 时，将归类为“即将到期”。</template>
         </n-form-item>
        </n-form>
      </div>

      <!-- Progress Stage -->
      <div v-else>
        <div class="text-center mb-4">
          <n-progress
            type="line"
            :percentage="updateProgress.total > 0 ? Math.floor((updateProgress.current / updateProgress.total) * 100) : 0"
            :indicator-placement="'inside'"
            processing
          />
          <p class="mt-2">
            <span v-if="updateLogLoading">正在更新: {{ updateProgress.current }} / {{ updateProgress.total }}</span>
            <span v-else>更新完成: {{ updateProgress.current }} / {{ updateProgress.total }}</span>
          </p>
        </div>
        <n-collapse>
          <n-collapse-item :title="`更新成功 (${updateLog.success.length})`" name="success">
            <div style="max-height: 200px; overflow-y: auto;">
              <n-tag v-for="sub in updateLog.success" :key="sub.name" type="success" class="m-1">
                {{ sub.name }}
              </n-tag>
              <n-text v-if="updateLog.success.length === 0">没有订阅成功更新。</n-text>
            </div>
          </n-collapse-item>
         <n-collapse-item :title="`即将到期 (${updateLog.expiring.length})`" name="expiring">
           <div style="max-height: 200px; overflow-y: auto;">
             <div v-if="updateLog.expiring.length > 0">
               <div v-for="sub in updateLog.expiring" :key="sub.id" class="mb-2 p-2 border rounded border-yellow-500">
                 <div class="flex justify-between items-center">
                   <n-tag type="warning">{{ sub.name }}</n-tag>
                   <n-space :size="4">
                     <n-tag v-if="sub.remaining_traffic !== null && sub.remaining_traffic !== undefined" size="small" type="warning">
                       流量: {{ formatBytes(sub.remaining_traffic) }}
                     </n-tag>
                     <n-tag v-if="sub.remaining_days !== null && sub.remaining_days !== undefined" size="small" type="warning">
                       天数: {{ sub.remaining_days }} 天
                     </n-tag>
                   </n-space>
                 </div>
               </div>
             </div>
             <n-text v-else>没有即将到期的订阅。</n-text>
           </div>
         </n-collapse-item>
          <n-collapse-item :title="`更新失败 (${updateLog.failed.length})`" name="failed">
             <div style="max-height: 200px; overflow-y: auto;">
              <div v-if="updateLog.failed.length > 0">
                <div v-for="sub in updateLog.failed" :key="sub.id" class="mb-2 p-2 border rounded">
                   <div class="flex justify-between items-center">
                     <n-tag type="error">{{ sub.name }}</n-tag>
                     <n-space :size="4">
                       <n-tag v-if="sub.remaining_traffic !== null && sub.remaining_traffic !== undefined" size="small" :type="sub.remaining_traffic === 0 ? 'error' : 'default'">
                         流量: {{ formatBytes(sub.remaining_traffic) }}
                       </n-tag>
                        <n-tag v-if="sub.remaining_days !== null && sub.remaining_days !== undefined" size="small" :type="sub.remaining_days <= 0 ? 'error' : 'default'">
                         天数: {{ sub.remaining_days }} 天
                       </n-tag>
                     </n-space>
                   </div>
                   <n-text class="text-xs text-gray-500 mt-1 block">{{ sub.error }}</n-text>
                </div>
              </div>
              <n-text v-else>没有订阅更新失败。</n-text>
            </div>
          </n-collapse-item>
        </n-collapse>
      </div>

      <template #footer>
        <n-space justify="end">
          <div v-if="updateStage === 'config'">
            <n-button @click="showUpdateLogModal = false">取消</n-button>
            <n-button type="primary" @click="executeSubscriptionUpdates">开始更新</n-button>
          </div>
          <div v-else>
            <n-button @click="handleCancelUpdate">{{ updateLogLoading ? '中止' : '关闭' }}</n-button>
            <n-button
              type="primary"
              ghost
              @click="handleRetryFailed"
              :disabled="updateLog.failed.filter(s => s.error !== '已中止').length === 0 || updateLogLoading"
            >
              重试失败项
            </n-button>
             <n-button
              type="warning"
              ghost
              @click="handleClearExpiring"
              :disabled="updateLog.expiring.length === 0 || updateLogLoading"
            >
              清除即将到期
            </n-button>
             <n-button
              type="error"
              ghost
              @click="handleClearFailed"
              :disabled="updateLog.failed.filter(s => s.error !== '已中止').length === 0 || updateLogLoading"
            >
              清除失败项
            </n-button>
          </div>
        </n-space>
      </template>
    </n-modal>

  </div>

    <n-modal
      v-model:show="showExportModal"
      preset="card"
      :title="`导出分组 '${exportData.groupName}' 的订阅`"
      style="width: 600px;"
      :mask-closable="false"
    >
      <p class="mb-2">共 {{ exportData.count }} 个订阅链接：</p>
      <n-input
        v-model:value="exportData.urls"
        type="textarea"
        readonly
        :autosize="{ minRows: 10, maxRows: 20 }"
        placeholder="没有订阅链接"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="showExportModal = false">关闭</n-button>
          <n-button type="primary" @click="handleCopyExportUrls">复制</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showBatchReplaceModal"
      preset="card"
      title="批量替换订阅链接"
      style="width: 600px;"
      :mask-closable="false"
    >
      <p class="mb-4">将对该分组下的 <b>{{ batchReplaceData.count }}</b> 个订阅链接执行替换操作。</p>
      <n-form>
        <n-form-item label="查找内容">
          <n-input v-model:value="batchReplaceData.find" placeholder="例如，旧的域名或参数" />
        </n-form-item>
        <n-form-item label="替换为">
          <n-input v-model:value="batchReplaceData.replace" placeholder="例如，新的域名或参数（可留空）" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showBatchReplaceModal = false">取消</n-button>
          <n-button type="primary" @click="handleBatchReplace" :loading="batchReplaceData.loading">确认替换</n-button>
        </n-space>
      </template>
    </n-modal>

</template>

<style scoped>
.group-tab-wrapper {
  display: flex;
  align-items: center;
  padding: 0 4px;
}

.group-actions-button {
  transition: opacity 0.2s;
}
</style>