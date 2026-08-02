import { asyncHandler } from '../../utils/asyncHandler.js';
import * as menuService from './menu.service.js';

export const createCategory = asyncHandler(async (req, res) => {
  const category = await menuService.createCategory(req.user.id, req.body);
  res.status(201).json(category);
});

export const listCategories = asyncHandler(async (req, res) => {
  const categories = await menuService.listCategories(req.user.id);
  res.status(200).json(categories);
});

export const updateCategory = asyncHandler(async (req, res) => {
  const category = await menuService.updateCategory(req.user.id, req.params.categoryId, req.body);
  res.status(200).json(category);
});

export const deleteCategory = asyncHandler(async (req, res) => {
  await menuService.deleteCategory(req.user.id, req.params.categoryId);
  res.status(200).json({ message: 'Category deleted.' });
});

export const createItem = asyncHandler(async (req, res) => {
  const item = await menuService.createItem(req.user.id, req.body);
  res.status(201).json(item);
});

export const listItems = asyncHandler(async (req, res) => {
  const items = await menuService.listItems(req.user.id, req.query);
  res.status(200).json(items);
});

export const getItem = asyncHandler(async (req, res) => {
  const item = await menuService.getItem(req.user.id, req.params.itemId);
  res.status(200).json(item);
});

export const updateItem = asyncHandler(async (req, res) => {
  const item = await menuService.updateItem(req.user.id, req.params.itemId, req.body);
  res.status(200).json(item);
});

export const deleteItem = asyncHandler(async (req, res) => {
  await menuService.deleteItem(req.user.id, req.params.itemId);
  res.status(200).json({ message: 'Menu item deleted.' });
});