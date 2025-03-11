docker exec \
    -it $PG_DB_CONTAINER \
    psql \
    -U root \
    -d ecomm-be \
    -c "SELECT * FROM pg_create_logical_replication_slot('${OUTBOX_REPLICATION_SLOT}', 'wal2json');"