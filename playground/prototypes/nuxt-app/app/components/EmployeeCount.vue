<script setup lang="ts">
defineProps({ count: { type: Number, required: true, validator: (value: number) => value >= 0 } })
</script>

<template>
  <span class="employee-count">{{ count }} employees</span>
</template>
