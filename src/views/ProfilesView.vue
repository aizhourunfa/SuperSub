<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import { useMessage, useDialog, NButton, NSpace, NDataTable, NPageHeader, NModal, NSpin, NIcon, NTag, NStatistic, NCard, NGrid, NGi, NScrollbar, NLog } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { Pencil as EditIcon, TrashBinOutline as DeleteIcon, CopyOutline as CopyIcon, EyeOutline as PreviewIcon } from '@vicons/ionicons5';
import { api } from '@/utils/api';
import { useAuthStore } from '@/stores/auth';
import { LogoutInProgressError } from '@/utils/errors';
import type { ApiResponse, Profile, Subscription, Node, LogEntry } from '@/types';
import { regenerateLink, type ParsedNode } from '@/utils/nodeParser';
import { getNaiveTagColor } from '@/utils/colors';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const profiles = ref<Profile[]>([]);
const loading = ref(true);
const authStore = useAuthStore();
const subToken = computed(() => authStore.user?.sub_token || '');

// For Nodes Preview Modal
const showNodesPreviewModal = ref(false);
const loadingNodesPreview = ref(false);
const currentProfileForPreview = ref<Profile | null>(null);
const nodesPreviewData = ref<{
  nodes: Partial<Node>[];
  analysis: {
    total: number;
    protocols: Record<string, number>;
    regions: Record<string, number>;
  };
  logs: LogEntry[];
  mode: 'local' | 'remote';
} | null>(null);

const logs = computed(() => nodesPreviewData.value?.logs || []);
const nodes = computed(() => nodesPreviewData.value?.nodes || []);

const formattedLogs = computed(() => {
  if (!logs.value || logs.value.length === 0) return '没有可显示的日志。';

  const header = `==================================================\n上帝视角日志: ${new Date(logs.value[0].timestamp).toISOString()}\n==================================================`;
  
  const body = logs.value.map((log: LogEntry) => {
    let logString = '';
    if (log.level === 'STEP') {
        logString = `\n================== 🚀 [${log.step}] ==================`;
    } else {
        const iconMap = { 'INFO': 'ℹ️', 'SUCCESS': '✅', 'WARN': '⚠️', 'ERROR': '❌', 'DEBUG': '🐞' };
        const icon = iconMap[log.level] || '➡️';
        logString = `${icon} [${log.level}] [${log.step}] ${log.message}`;
    }
    
    if (log.data) {
      logString += `\n   └─ DATA: ${JSON.stringify(log.data, null, 2)}`;
    }
    return logString;
  }).join('\n');

  const footer = '==================================================\n上帝视角日志结束\n==================================================';

  return `${header}\n${body}\n${footer}`;
});

const previewNodeColumns: DataTableColumns<Partial<Node>> = [
  { title: '节点名称', key: 'name', ellipsis: { tooltip: true } },
  {
    title: '类型',
    key: 'type',
    width: 100,
    align: 'center',
    render(row) {
        const protocol = row.protocol || row.type || 'N/A';
        return h(NTag, {
            size: 'small',
            round: true,
            color: getNaiveTagColor(protocol, 'protocol')
        }, { default: () => protocol.toUpperCase() });
    }
  },
  { title: '服务器', key: 'server', width: 150, ellipsis: { tooltip: true } },
  { title: '端口', key: 'port', width: 80, align: 'center' },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    align: 'center',
    render(row) {
      return h(NButton, {
        size: 'tiny',
        ghost: true,
        type: 'primary',
        onClick: () => {
          // The row object from preview is a ParsedNode.
          const link = regenerateLink(row as ParsedNode);
          if (link) {
            navigator.clipboard.writeText(link);
            message.success('已复制完整链接');
          } else {
            message.error('无法生成链接');
          }
        }
      }, { default: () => '复制链接' });
    }
  }
];


const createColumns = ({ onCopy, onPreview, onEdit, onDelete }: {
    onCopy: (row: Profile) => void,
    onPreview: (row: Profile) => void,
    onEdit: (row: Profile) => void,
    onDelete: (row: Profile) => void,
}): DataTableColumns<Profile> => {
  return [
    { title: '名称', key: 'name', sorter: 'default', width: 200 },
    {
      title: '订阅链接',
      key: 'alias',
      render(row) {
        if (!subToken.value || !row.alias) {
          return h('span', '请设置链接别名');
        }
        const url = `${window.location.origin}/api/public/${subToken.value}/${row.alias}`;
        return h(NButton, { text: true, tag: 'a', href: url, target: '_blank', type: 'primary' }, { default: () => url });
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render(row) {
        return h(NSpace, null, {
          default: () => [
            h(NButton, { size: 'small', circle: true, title: '复制链接', onClick: () => onCopy(row) }, { icon: () => h(NIcon, null, { default: () => h(CopyIcon) }) }),
            h(NButton, { size: 'small', circle: true, title: '预览', onClick: () => onPreview(row) }, { icon: () => h(NIcon, null, { default: () => h(PreviewIcon) }) }),
            h(NButton, { size: 'small', circle: true, type: 'primary', title: '编辑', onClick: () => router.push({ name: 'edit-profile', params: { id: row.id } }) }, { icon: () => h(NIcon, null, { default: () => h(EditIcon) }) }),
            h(NButton, { size: 'small', circle: true, type: 'error', title: '删除', onClick: () => onDelete(row) }, { icon: () => h(NIcon, null, { default: () => h(DeleteIcon) }) }),
          ]
        });
      }
    }
  ];
};


const fetchProfiles = async () => {
  const authStore = useAuthStore();
  if (!authStore.isAuthenticated) return;
  loading.value = true;
  try {
    const response = await api.get<ApiResponse<Profile[]>>('/profiles');
    if (response.data.success) {
      profiles.value = response.data.data || [];
    } else {
      message.error(response.data.message || '获取配置列表失败');
    }
  } catch (err: any) {
    if (!axios.isCancel(err)) message.error(err.message || '请求失败');
  } finally {
    loading.value = false;
  }
};



const handleDelete = (row: Profile) => {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除配置 "${row.name}" 吗？`,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await api.delete<ApiResponse>(`/profiles/${row.id}`);
        if (response.data.success) {
          message.success('配置删除成功');
          fetchProfiles();
        } else {
          message.error(response.data.message || '删除失败');
        }
      } catch (err: any) {
        if (!axios.isCancel(err)) message.error(err.message || '请求失败');
      }
    },
  });
};

const handleCopyLink = (row: Profile) => {
  if (!subToken.value || !row.alias) {
    message.error('无法复制链接：缺少订阅令牌或链接别名。');
    return;
  }
  const url = `${window.location.origin}/api/public/${subToken.value}/${row.alias}`;
  navigator.clipboard.writeText(url).then(() => message.success('链接已复制'), () => message.error('复制失败'));
};

const onPreview = async (row: Profile) => {
  currentProfileForPreview.value = row;
  nodesPreviewData.value = null;
  loadingNodesPreview.value = true;
  showNodesPreviewModal.value = true;
  try {
    const response = await api.get<ApiResponse<typeof nodesPreviewData.value>>(`/profiles/${row.id}/preview-nodes`);
    if (response.data.success) {
      if (response.data.data) {
        nodesPreviewData.value = response.data.data;
      }
    } else {
      message.error(response.data.message || '加载预览失败');
      showNodesPreviewModal.value = false;
    }
  } catch (err: any) {
    if (!axios.isCancel(err)) {
      message.error(err.message || '请求预览失败');
      showNodesPreviewModal.value = false;
    }
  } finally {
    loadingNodesPreview.value = false;
  }
};

const columns = createColumns({ onCopy: handleCopyLink, onPreview, onEdit: (row) => router.push({ name: 'edit-profile', params: { id: row.id } }), onDelete: handleDelete });

onMounted(() => {
  fetchProfiles();
});

</script>

<template>
  <div>
    <n-page-header>
      <template #title>配置管理</template>
      <template #extra>
        <n-space>
          <n-button type="primary" @click="() => router.push({ name: 'new-profile' })">新增配置</n-button>
        </n-space>
      </template>
    </n-page-header>

    <n-data-table :columns="columns" :data="profiles" :loading="loading" :pagination="{ pageSize: 10 }" :bordered="false" class="mt-4" />


    <!-- Nodes Preview Modal -->
    <n-modal v-model:show="showNodesPreviewModal" preset="card" :title="`节点预览 - ${currentProfileForPreview?.name}`" style="width: 1200px;" :mask-closable="true" :trap-focus="false">
      <n-spin :show="loadingNodesPreview">
        <div v-if="nodesPreviewData">
          <n-grid :cols="2" :x-gap="12">
            <n-gi>
              <n-card title="上帝日志" size="small" style="height: 100%;">
                <n-scrollbar style="max-height: 600px;">
                  <n-log :log="formattedLogs" language="text" trim />
                </n-scrollbar>
              </n-card>
            </n-gi>
            <n-gi>
              <n-card title="订阅分析" :bordered="false">
                <n-grid :cols="3" :x-gap="12">
                  <n-gi><n-statistic label="节点总数" :value="nodesPreviewData.analysis.total" /></n-gi>
                  <n-gi>
                    <n-statistic label="协议分布">
                      <n-space>
                      <n-tag v-for="(count, protocol) in nodesPreviewData.analysis.protocols" :key="protocol" :color="getNaiveTagColor(protocol, 'protocol')" round>{{ protocol.toUpperCase() }}: {{ count }}</n-tag>
                      </n-space>
                    </n-statistic>
                  </n-gi>
                  <n-gi>
                    <n-statistic label="地区分布">
                      <n-space :size="'small'" style="flex-wrap: wrap;">
                        <n-tag v-for="(count, region) in nodesPreviewData.analysis.regions" :key="region" :color="getNaiveTagColor(region, 'region')" round>{{ region }}: {{ count }}</n-tag>
                      </n-space>
                    </n-statistic>
                  </n-gi>
                </n-grid>
              </n-card>
              <n-data-table :columns="previewNodeColumns" :data="nodes" :pagination="{ pageSize: 10 }" :max-height="400" class="mt-4" />
            </n-gi>
          </n-grid>
        </div>
        <div v-else-if="!loadingNodesPreview" style="text-align: center; padding: 20px;">没有获取到节点数据。</div>
      </n-spin>
    </n-modal>
  </div>
</template>