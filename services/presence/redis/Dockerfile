FROM redis:7-alpine

# Fly's private network between apps is IPv6 (6PN), so binding only 0.0.0.0
# leaves the service reachable from inside its own Machine and nowhere else.
#
# Presence state is disposable: every client republishes within one TTL of a
# restart, so persistence buys nothing and costs a volume. `--save ""` turns
# RDB snapshots off, and allkeys-lru means a memory ceiling sheds the oldest
# entries instead of refusing writes.
CMD ["sh", "-c", "exec redis-server \
  --bind :: 0.0.0.0 \
  --protected-mode no \
  --requirepass \"$REDIS_PASSWORD\" \
  --maxmemory 200mb \
  --maxmemory-policy allkeys-lru \
  --save ''"]
