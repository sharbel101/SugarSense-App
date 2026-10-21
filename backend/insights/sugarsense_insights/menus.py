"""What the model MAY say about a pattern. Python owns this list; the model only chooses from it and words it.

Each option is a hedged possibility ("explanation") or a gentle next step ("suggestion"), written as a statement of possibility or a pointer, never an instruction to dose.
`care_team=True` options concern insulin, basal or settings: the paragraph must send the reader to their care team when it uses one (checked by the validator).
Nothing here states a unit count, a dose, an exact timing, or a diagnosis, and nothing here can be combined into one.
"""
from __future__ import annotations

from .models import Option

# ---- possible explanations (hedged by construction) ------------------------------------------------------------------------
BASAL_COVERAGE = Option("basal_coverage", "background (basal) insulin may not be covering this part of the day well", care_team=True)
INSULIN_EFFECTIVENESS = Option("insulin_effectiveness", "the insulin itself may be working less well, for example if it is past its expiry date, was stored too warm or too cold, or the injection or pump site is tired")
STRESS_ILLNESS_SLEEP = Option("stress_illness_sleep", "stress, an illness coming on, or a poor night can raise glucose without any food")
EARLY_MORNING_HORMONES = Option("early_morning_hormones", "the body releases hormones in the early morning that can push glucose up")
UNLOGGED_FOOD = Option("unlogged_food", "something eaten or drunk that was not logged")
MORNING_SETTING = Option("morning_setting", "your own morning insulin-resistance setting says the morning needs more insulin for the same effect, and this may be a sign it is not fully covering it", care_team=True)
INSULIN_TIMING = Option("insulin_timing", "insulin takes a while to start working while the meal's carbohydrate can arrive quickly, so a dose taken at or after the start of the meal can lag behind the rise")
MEAL_COMPOSITION = Option("meal_composition", "a meal heavy in fast-digesting carbohydrate can raise glucose sharply")
MEAL_SIZE = Option("meal_size", "the size of the meal compared with how much insulin it was matched with")
ACTIVITY_SENSITIVITY = Option("activity_sensitivity", "activity can make the body more sensitive to insulin for hours afterwards, which can lead to a late low")
DOSE_VS_CARBS = Option("dose_vs_carbs", "the dose may have been larger than that meal or glucose level needed", care_team=True)
DOSE_OVERLAP = Option("dose_overlap", "insulin from an earlier dose may still have been acting when another was given", care_team=True)

# ---- gentle next steps (pointers, never instructions to dose) -------------------------------------------------------------
CHECK_INSULIN_STORAGE = Option("check_insulin_storage", "it is worth checking the expiry date and storage of the pen or vial, and rotating the injection or pump site")
DISCUSS_BASAL = Option("discuss_basal", "something to raise with your care team is whether your background insulin needs a review", care_team=True)
LOG_CONTEXT = Option("log_context", "noting meals, late snacks, stress, illness and sleep in the app for a few days would help narrow down the cause")
DISCUSS_PREBOLUS = Option("discuss_prebolus", "something to discuss with your care team is whether taking mealtime insulin earlier would suit big meals like this one", care_team=True)
DISCUSS_MEAL_SIZE = Option("discuss_meal_size", "a smaller portion or a different mix for this meal could be something to try, and to talk through with your care team")
DISCUSS_MORNING_SETTING = Option("discuss_morning_setting", "it may be worth asking your care team whether your morning setting should be reviewed", care_team=True)
WATCH_AFTER_ACTIVITY = Option("watch_after_activity", "it is worth keeping an eye on glucose for several hours after activity and discussing a plan for it with your care team", care_team=True)
DISCUSS_DOSE_REVIEW = Option("discuss_dose_review", "something to talk through with your care team is how doses and meals matched up around then", care_team=True)

# ---- menus per pattern -------------------------------------------------------------------------------------------------
UNEXPLAINED_HIGH = ([BASAL_COVERAGE, INSULIN_EFFECTIVENESS, STRESS_ILLNESS_SLEEP, EARLY_MORNING_HORMONES, UNLOGGED_FOOD], [CHECK_INSULIN_STORAGE, DISCUSS_BASAL, LOG_CONTEXT])
BIG_MEAL_SPIKE = ([INSULIN_TIMING, MEAL_COMPOSITION, MEAL_SIZE], [DISCUSS_PREBOLUS, DISCUSS_MEAL_SIZE, LOG_CONTEXT])
BIG_MEAL_SPIKE_DOSE_ALREADY_EARLY = ([MEAL_COMPOSITION, MEAL_SIZE], [DISCUSS_MEAL_SIZE, LOG_CONTEXT])   # dose was logged before the meal: timing is not the story
MORNING_PATTERN = ([EARLY_MORNING_HORMONES, BASAL_COVERAGE, INSULIN_EFFECTIVENESS], [DISCUSS_BASAL, LOG_CONTEXT])
MORNING_PATTERN_WITH_SETTING = ([MORNING_SETTING, EARLY_MORNING_HORMONES, BASAL_COVERAGE], [DISCUSS_MORNING_SETTING, LOG_CONTEXT])
POST_ACTIVITY_LOW = ([ACTIVITY_SENSITIVITY], [WATCH_AFTER_ACTIVITY])
LOW_AFTER_DOSE = ([DOSE_VS_CARBS, DOSE_OVERLAP], [DISCUSS_DOSE_REVIEW])

# ---- frequent lows -----------------------------------------------------------------------------------------------------
DOSE_FOOD_BALANCE = Option("dose_food_balance", "a dose that was large for the food it covered, or a meal that ended up smaller or later than planned, can lead to a low a few hours afterwards", care_team=True)
DISCUSS_FREQUENT_LOWS = Option("discuss_frequent_lows", "lows that come back this often are worth going through with your care team, along with what your plan is for treating them", care_team=True)
FREQUENT_LOWS = ([DOSE_FOOD_BALANCE, ACTIVITY_SENSITIVITY], [DISCUSS_FREQUENT_LOWS, LOG_CONTEXT])
