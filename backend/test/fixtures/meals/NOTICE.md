# Fixture image attribution

All images in this directory are from Wikimedia Commons, chosen via the Commons API for images with
open licenses (CC0/CC-BY/CC-BY-SA), and used here only as inputs to an automated test - not
redistributed or displayed anywhere in the product. Attribution is required by the CC BY / CC BY-SA
licenses below and is provided here for good measure even for CC0 files.

| File | Source | Author | License |
|---|---|---|---|
| `rice_bowl.jpg` | [A bowl of rice.jpg](https://commons.wikimedia.org/wiki/File:A_bowl_of_rice.jpg) | Douglas Perkins | CC0 |
| `banana.jpg` | [SingleYelakki banana, bangalore, karnataka single.jpg](https://commons.wikimedia.org/wiki/File:SingleYelakki_banana,_bangalore,_karnataka_single.jpg) | Mohanramus | CC BY 4.0 |
| `salad.jpg` | [Mixed green salad.jpg](https://commons.wikimedia.org/wiki/File:Mixed_green_salad.jpg) | FranHogan | CC BY-SA 4.0 |
| `pizza_slice.jpg` | [Slice House pizza (38501729515).jpg](https://commons.wikimedia.org/wiki/File:Slice_House_pizza_(38501729515).jpg) | Dale Cruse | CC BY 2.0 |
| `chicken_zucchini.jpg` | [Chicken and Zucchini dinner.jpg](https://commons.wikimedia.org/wiki/File:Chicken_and_Zucchini_dinner.jpg) | Infrogmation of New Orleans | CC BY-SA 4.0 |
| `no_food_laptop.jpg` | [Laptop on a desk (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Laptop_on_a_desk_(Unsplash).jpg) | Aleksi Tappura | CC0 |

`no_food_laptop.jpg` is the negative-control fixture for the `no_food_detected` path - it is not a
food photo and is not counted among the "3-5 sample food photos" in
`../meals-analyze.fixtures.e2e-spec.ts`.

These are placeholders, not the "real accuracy-measurement harness" - see
`../../src/meals/README.md` for what that follow-up task needs (real device photos of weighed meals).
