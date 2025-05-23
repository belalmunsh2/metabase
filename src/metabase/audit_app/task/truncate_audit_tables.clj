(ns metabase.audit-app.task.truncate-audit-tables
  "Tasks for truncating audit-related tables, particularly `audit_log`, `view_log`, and `query_execution`, based on a
  configured retention policy."
  (:require
   [clojurewerkz.quartzite.jobs :as jobs]
   [clojurewerkz.quartzite.schedule.cron :as cron]
   [clojurewerkz.quartzite.triggers :as triggers]
   [java-time.api :as t]
   [metabase.db :as mdb]
   [metabase.premium-features.core :refer [defenterprise]]
   [metabase.settings.core :as setting :refer [defsetting]]
   [metabase.task-history.core :as task-history]
   [metabase.task.core :as task]
   [metabase.util.i18n :refer [deferred-tru]]
   [metabase.util.log :as log]
   [toucan2.core :as t2]))

(set! *warn-on-reflection* true)

(def min-retention-days
  "Minimum allowed value for `audit-max-retention-days`."
  30)

(def default-retention-days
  "Default value for `audit-max-retention-days`."
  720)

(defn log-minimum-value-warning
  "Logs a warning that the value for `audit-max-retention-days` is below the allowed minimum and will be overriden."
  [env-var-value]
  (log/warnf "MB_AUDIT_MAX_RETENTION_DAYS is set to %d; using the minimum value of %d instead."
             env-var-value
             min-retention-days))

(defsetting audit-max-retention-days
  (deferred-tru "Number of days to retain data in audit-related tables. Minimum value is 30; set to 0 to retain data indefinitely.")
  :visibility :internal
  :setter     :none
  :audit      :never
  :getter     (fn []
                (let [env-var-value (setting/get-value-of-type :integer :audit-max-retention-days)]
                  (cond
                    (nil? env-var-value)
                    default-retention-days

                    ;; Treat 0 as an alias for infinity
                    (zero? env-var-value)
                    ##Inf

                    (< env-var-value min-retention-days)
                    (do
                      (log-minimum-value-warning env-var-value)
                      min-retention-days)

                    :else
                    env-var-value)))
  :doc "Sets the maximum number of days Metabase preserves rows for the following application database tables:

- `query_execution`
- `audit_log`
- `view_log`

Twice a day, Metabase will delete rows older than this threshold. The minimum value is 30 days (Metabase will treat entered values of 1 to 29 the same as 30).
If set to 0, Metabase will keep all rows.")

(defsetting audit-table-truncation-batch-size
  (deferred-tru "Batch size to use for deletion of old rows for audit-related tables (like query_execution). Can be only set as an environment variable.")
  :visibility :internal
  :setter     :none
  :type       :integer
  :default    50000
  :audit      :never
  :export?    false)

(defn- truncate-table-batched!
  [table-name time-column]
  (t2/query-one
   (case (mdb/db-type)
     (:postgres :h2)
     {:delete-from (keyword table-name)
      :where [:in
              :id
              {:select [:id]
               :from (keyword table-name)
               :where [:<=
                       (keyword time-column)
                       (t/minus (t/offset-date-time) (t/days (audit-max-retention-days)))]
               :order-by [[:id :asc]]
               :limit (audit-table-truncation-batch-size)}]}

     (:mysql :mariadb)
     {:delete-from (keyword table-name)
      :where [:<=
              (keyword time-column)
              (t/minus (t/offset-date-time) (t/days (audit-max-retention-days)))]
      :limit (audit-table-truncation-batch-size)})))

(defn- truncate-table!
  "Given a model, deletes all rows older than the configured threshold"
  [model time-column]
  (when-not (infinite? (audit-max-retention-days))
    (let [table-name (name (t2/table-name model))]
      (try
        (log/infof "Cleaning up %s table" table-name)
        (loop [total-rows-deleted 0]
          (let [batch-rows-deleted (truncate-table-batched! table-name time-column)]
            ;; Only try to delete another batch if the last batch was full
            (if (= batch-rows-deleted (audit-table-truncation-batch-size))
              (recur (+ total-rows-deleted (long batch-rows-deleted)))
              (if (not= total-rows-deleted 0)
                (log/infof "%s cleanup successful, %d rows were deleted" table-name total-rows-deleted)
                (log/infof "%s cleanup successful, no rows were deleted" table-name)))))
        (catch Throwable e
          (log/errorf e "%s cleanup failed" table-name))))))

(defenterprise audit-models-to-truncate
  "List of models to truncate. OSS implementation only truncates `query_execution` table."
  metabase-enterprise.audit-app.task.truncate-audit-tables
  []
  [{:model :model/QueryExecution :timestamp-col :started_at}])

(defn- truncate-audit-tables!
  []
  (run!
   (fn [{:keys [model timestamp-col]}]
     (task-history/with-task-history {:task "task-history-cleanup"}
       (truncate-table! model timestamp-col)))
   (audit-models-to-truncate)))

(task/defjob ^{:doc "Triggers the removal of `query_execution` rows older than the configured threshold."} TruncateAuditTables [_]
  (truncate-audit-tables!))

(def ^:private truncate-audit-tables-job-key "metabase.task.truncate-audit-tables.job")
(def ^:private truncate-audit-tables-trigger-key "metabase.task.truncate-audit-tables.trigger")
(def ^:private truncate-audit-tables-cron "0 0 */12 * * ? *") ;; Run every 12 hours

(defmethod task/init! ::TruncateAuditTables [_]
  (let [job     (jobs/build
                 (jobs/of-type TruncateAuditTables)
                 (jobs/with-identity (jobs/key truncate-audit-tables-job-key)))
        trigger (triggers/build
                 (triggers/with-identity (triggers/key truncate-audit-tables-trigger-key))
                 (triggers/start-now)
                 (triggers/with-schedule
                  (cron/schedule
                   (cron/cron-schedule truncate-audit-tables-cron)
                   (cron/with-misfire-handling-instruction-do-nothing))))]
    (task/schedule-task! job trigger)))
